import {
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient } from "./client.js";
import { DEFAULT_COMPLETION_MODEL } from "./completions.js";
import type {
  ChatBlock,
  StopReason,
  ToolCallingProvider,
  ToolChatRequest,
  ToolChatResult,
} from "../tools.js";

// Converse's toolConfig works across Nova and Claude with one request shape,
// which is the reason this adapter carries no model-family branching.

function toBedrock(block: ChatBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "tool_use":
      return {
        toolUse: { toolUseId: block.id, name: block.name, input: block.input as never },
      };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          ...(block.isError ? { status: "error" as const } : {}),
        },
      };
  }
}

function fromBedrock(block: ContentBlock): ChatBlock | null {
  if (block.text !== undefined) return { type: "text", text: block.text };
  if (block.toolUse) {
    return {
      type: "tool_use",
      id: block.toolUse.toolUseId ?? "",
      name: block.toolUse.name ?? "",
      input: block.toolUse.input ?? {},
    };
  }
  // reasoningContent, images, guard content: not part of our vocabulary.
  return null;
}

function stopReason(value: string | undefined): StopReason {
  if (value === "tool_use" || value === "end_turn" || value === "max_tokens") return value;
  return "other";
}

export class BedrockToolCallingProvider implements ToolCallingProvider {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string = DEFAULT_COMPLETION_MODEL,
  ) {}

  async chat(request: ToolChatRequest): Promise<ToolChatResult> {
    const messages: Message[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content.map(toBedrock),
    }));
    const tools: Tool[] = request.tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.inputSchema as never },
      },
    }));

    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        messages,
        ...(request.system === undefined ? {} : { system: [{ text: request.system }] }),
        ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
        inferenceConfig: {
          maxTokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0,
        },
      }),
    );

    const content = (response.output?.message?.content ?? [])
      .map(fromBedrock)
      .filter((block): block is ChatBlock => block !== null);

    return {
      model: this.modelId,
      stopReason: stopReason(response.stopReason),
      content,
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }
}
