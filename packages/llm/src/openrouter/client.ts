import type { CompletionProvider, CompletionRequest, CompletionResult } from "../types.js";
import type {
  ChatBlock,
  StopReason,
  ToolCallingProvider,
  ToolChatRequest,
  ToolChatResult,
} from "../tools.js";

// OpenRouter speaks the OpenAI chat-completions dialect over plain HTTPS, so
// this adapter is fetch and nothing else -- no SDK dependency to audit. It
// exists for two reasons (ARCHITECTURE.md): as the fallback when Bedrock model
// access or quota is the blocker, and as the second real vendor that proves a
// provider swap is configuration only.
//
// Completions and tool calling only. Embeddings stay on Titan: a vector from
// another model is not comparable with the stored ones (ADR-0006), so "swap the
// embedding provider" is a migration, not something this adapter should make
// look like a config flag.

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-haiku-4.5";

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: OpenAiMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function toOpenAi(request: {
  system?: string | undefined;
  messages: { role: "user" | "assistant"; content: ChatBlock[] }[];
}): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (request.system !== undefined) out.push({ role: "system", content: request.system });

  for (const message of request.messages) {
    const text = message.content
      .filter((b): b is Extract<ChatBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (message.role === "assistant") {
      const calls = message.content.filter(
        (b): b is Extract<ChatBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    // A user turn may carry tool results; in this dialect each becomes its own
    // `tool` message, and they must come before any user text in that turn.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.isError ? `ERROR: ${block.content}` : block.content,
        });
      }
    }
    if (text !== "") out.push({ role: "user", content: text });
  }
  return out;
}

function stopReason(value: string | undefined): StopReason {
  if (value === "tool_calls") return "tool_use";
  if (value === "stop") return "end_turn";
  if (value === "length") return "max_tokens";
  return "other";
}

export class OpenRouterProvider implements CompletionProvider, ToolCallingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_OPENROUTER_MODEL,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = OPENROUTER_BASE_URL,
  ) {
    if (apiKey === "") throw new Error("OpenRouter API key is empty");
  }

  private async post(body: Record<string, unknown>): Promise<OpenAiResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-title": "compass",
      },
      body: JSON.stringify({ model: this.model, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    const parsed = (await response.json().catch(() => ({}))) as OpenAiResponse;
    if (!response.ok) {
      // The key never appears in the error -- only status and vendor message.
      throw new Error(
        `OpenRouter ${response.status}: ${parsed.error?.message ?? response.statusText}`,
      );
    }
    return parsed;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const parsed = await this.post({
      messages: toOpenAi({
        system: request.system,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: [{ type: "text" as const, text: m.content }],
        })),
      }),
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0,
    });
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string")
      throw new Error(`OpenRouter model ${this.model} returned no text`);
    return {
      model: parsed.model ?? this.model,
      text,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
    };
  }

  async chat(request: ToolChatRequest): Promise<ToolChatResult> {
    const parsed = await this.post({
      messages: toOpenAi(request),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0,
    });

    const choice = parsed.choices?.[0];
    const content: ChatBlock[] = [];
    if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
    for (const call of choice?.message?.tool_calls ?? []) {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Kept as the raw string: the agent's argument validation rejects it
        // and reports that back to the model, which is the designed path for
        // malformed arguments (COMPASS-22) -- not an exception here.
        input = call.function.arguments;
      }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }

    return {
      model: parsed.model ?? this.model,
      stopReason: stopReason(choice?.finish_reason),
      content,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
    };
  }
}
