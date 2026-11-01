// Tool calling (COMPASS-21) as a third interface beside completions and
// embeddings, rather than an option on CompletionProvider. A tool turn has a
// different shape -- content is a list of blocks, and the model can stop to
// ask for a tool instead of answering -- and a plain RAG answer should not
// have to know that shape exists.
//
// The block vocabulary mirrors what both Bedrock Converse and the OpenAI-style
// chat API (OpenRouter) can express, and nothing either one cannot: text,
// tool_use, tool_result. Vendor-specific extras stay inside the adapters.

/** JSON Schema for the tool's input object. Sent to the model verbatim. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatBlock[];
}

export interface ToolChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ToolChatResult {
  model: string;
  stopReason: StopReason;
  content: ChatBlock[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface ToolCallingProvider {
  chat(request: ToolChatRequest): Promise<ToolChatResult>;
}

export function textOf(blocks: ChatBlock[]): string {
  return blocks
    .filter((block): block is Extract<ChatBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function toolUsesOf(blocks: ChatBlock[]): Extract<ChatBlock, { type: "tool_use" }>[] {
  return blocks.filter(
    (block): block is Extract<ChatBlock, { type: "tool_use" }> => block.type === "tool_use",
  );
}
