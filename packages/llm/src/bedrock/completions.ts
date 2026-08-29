import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient } from "./client.js";
import type { CompletionProvider, CompletionRequest, CompletionResult } from "../types.js";

// Every Claude model in eu-west-1 is INFERENCE_PROFILE-only: the bare
// `anthropic.claude-*` model id is rejected with a validation error, and the
// profile id must be used instead. The `eu.` prefix keeps inference routing
// inside EU regions; `global.` profiles also exist and route anywhere.
// Haiku 4.5 for cost -- trading up is a configuration change.
export const DEFAULT_COMPLETION_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

export class BedrockCompletionProvider implements CompletionProvider {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string = DEFAULT_COMPLETION_MODEL,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // Converse rather than InvokeModel: it takes a uniform message shape across
    // vendors, so this adapter carries no Anthropic-specific request JSON.
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: [{ text: message.content }],
        })),
        ...(request.system === undefined ? {} : { system: [{ text: request.system }] }),
        inferenceConfig: {
          maxTokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0,
        },
      }),
    );

    const text = response.output?.message?.content?.[0]?.text;
    if (text === undefined) {
      throw new Error(
        `Bedrock model ${this.modelId} returned no text content ` +
          `(stopReason: ${response.stopReason ?? "unknown"})`,
      );
    }

    return {
      model: this.modelId,
      text,
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }
}
