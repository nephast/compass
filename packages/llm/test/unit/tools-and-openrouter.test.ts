import { describe, expect, it } from "vitest";
import {
  completionProviderFromEnv,
  embeddingProviderFromEnv,
  FakeToolCallingProvider,
  OpenRouterProvider,
  toolCallingProviderFromEnv,
  type ToolSpec,
} from "../../src/index.js";
import { completionProviderContract } from "../contract/provider-contract.js";

const tools: ToolSpec[] = [
  {
    name: "get_aws_cost_summary",
    description: "cost",
    inputSchema: { type: "object", properties: {} },
  },
];

// A canned OpenRouter, so the adapter's dialect translation is tested with no
// network: the contract runs against the real class over a fake transport.
function stubFetch(reply: (body: Record<string, unknown>) => unknown, status = 200) {
  const calls: Record<string, unknown>[] = [];
  const impl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify(reply(body)), { status });
  };
  return { impl, calls };
}

const echo = stubFetch((body) => {
  const messages = body.messages as { role: string; content: string }[];
  const last = [...messages].reverse().find((m) => m.role === "user");
  return {
    model: "stub/model",
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: `[stub] ${last?.content}` } },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
});
completionProviderContract(
  "openrouter (stubbed transport)",
  () => new OpenRouterProvider("k", "stub/model", echo.impl),
);

describe("OpenRouterProvider tool dialect", () => {
  it("translates tool calls out and tool results back in", async () => {
    const stub = stubFetch(() => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_aws_cost_summary", arguments: '{"days":7}' },
              },
            ],
          },
        },
      ],
    }));
    const provider = new OpenRouterProvider("k", "m", stub.impl);
    const result = await provider.chat({
      messages: [
        { role: "user", content: [{ type: "text", text: "spend?" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c0", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c0", content: "42" }] },
      ],
      tools,
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "tool_use", id: "c1", name: "get_aws_cost_summary", input: { days: 7 } },
    ]);
    const sent = stub.calls[0]!.messages as { role: string; tool_call_id?: string }[];
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(sent[2]!.tool_call_id).toBe("c0");
  });

  it("keeps malformed arguments as a raw string for the guardrail to reject", async () => {
    const stub = stubFetch(() => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "t", arguments: "{oops" } },
            ],
          },
        },
      ],
    }));
    const result = await new OpenRouterProvider("k", "m", stub.impl).chat({ messages: [], tools });
    expect(result.content[0]).toMatchObject({ type: "tool_use", input: "{oops" });
  });

  it("surfaces vendor errors without the key", async () => {
    const stub = stubFetch(() => ({ error: { message: "rate limited" } }), 429);
    await expect(
      new OpenRouterProvider("secret-key", "m", stub.impl).complete({
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrowError(/^OpenRouter 429: rate limited$/);
  });
});

describe("FakeToolCallingProvider", () => {
  it("requests the matching tool, then answers from its result", async () => {
    const provider = new FakeToolCallingProvider();
    const first = await provider.chat({
      messages: [{ role: "user", content: [{ type: "text", text: "How much did I spend?" }] }],
      tools,
    });
    expect(first.stopReason).toBe("tool_use");
    const second = await provider.chat({
      messages: [
        { role: "user", content: [{ type: "tool_result", toolUseId: "fake-1", content: "$3.20" }] },
      ],
      tools,
    });
    expect(second.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(second.content)).toMatch(/\$3\.20/);
  });

  it("refuses requests outside its tools", async () => {
    const result = await new FakeToolCallingProvider().chat({
      messages: [{ role: "user", content: [{ type: "text", text: "delete my bucket" }] }],
      tools,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(JSON.stringify(result.content)).toMatch(/can't/);
  });
});

describe("provider selection", () => {
  it("selects openrouter by config alone", () => {
    const env = { LLM_COMPLETION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" };
    expect(completionProviderFromEnv(env)).toBeInstanceOf(OpenRouterProvider);
    expect(toolCallingProviderFromEnv(env)).toBeInstanceOf(OpenRouterProvider);
  });

  it("refuses openrouter without a key, and for embeddings at all", () => {
    expect(() => completionProviderFromEnv({ LLM_COMPLETION_PROVIDER: "openrouter" })).toThrowError(
      /OPENROUTER_API_KEY/,
    );
    expect(() => embeddingProviderFromEnv({ LLM_EMBEDDING_PROVIDER: "openrouter" })).toThrowError(
      /ADR-0006/,
    );
  });
});
