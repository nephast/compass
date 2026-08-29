import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient } from "./client.js";
import type { CompletionProvider, CompletionRequest, CompletionResult } from "../types.js";

// Nova Lite rather than Claude, and the reason is availability, not preference:
// Anthropic and OpenAI models require a "use case details" form to be submitted
// for the account before they will answer, while Amazon's own models need
// nothing. A default that fails on a fresh account is the kind of friction that
// kills a project between sessions, so the default is a model that works out of
// the box. Trading up to Claude is one environment variable once the form is in.
//
// Note the id is an INFERENCE PROFILE, not a model id. Nova and Claude are both
// INFERENCE_PROFILE-only in eu-west-1: the bare `amazon.nova-lite-v1:0` is
// rejected with a validation error. The `eu.` prefix keeps inference routing
// inside EU regions; `global.` profiles also exist and route anywhere.
export const DEFAULT_COMPLETION_MODEL = "eu.amazon.nova-lite-v1:0";

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
