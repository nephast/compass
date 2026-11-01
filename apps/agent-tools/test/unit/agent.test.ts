import {
  FakeToolCallingProvider,
  type ChatBlock,
  type ToolCallingProvider,
  type ToolChatRequest,
  type ToolChatResult,
} from "@compass/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_MESSAGE, runAgent } from "../../src/agent.js";
import { ToolRegistry } from "../../src/registry.js";
import { alarmsTool } from "../../src/tools/alarms.js";
import { ciTool } from "../../src/tools/ci.js";
import { costTool } from "../../src/tools/cost.js";
import type { Tool } from "../../src/tools/types.js";

const executed: string[] = [];
function stubTool(
  name: string,
  result: unknown = { ok: true },
  schema: Tool["spec"]["inputSchema"] = {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
): Tool<never> {
  return {
    readOnly: true,
    spec: { name, description: name, inputSchema: schema },
    execute: async () => {
      executed.push(name);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Plays back a fixed list of model turns, recording what it was sent. */
function scripted(turns: ChatBlock[][]): ToolCallingProvider & { requests: ToolChatRequest[] } {
  const requests: ToolChatRequest[] = [];
  let index = 0;
  return {
    requests,
    async chat(request): Promise<ToolChatResult> {
      requests.push(structuredClone(request));
      const content = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return {
        model: "scripted",
        stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        content,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

const use = (name: string, input: unknown = {}, id = `id-${name}`): ChatBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (t: string): ChatBlock => ({ type: "text", text: t });

let logs: Record<string, unknown>[] = [];
beforeEach(() => {
  executed.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(JSON.parse(line)));
});
afterEach(() => vi.restoreAllMocks());

describe("registry", () => {
  const registry = new ToolRegistry([
    stubTool(
      "t",
      {},
      {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 31, default: 7 } },
        additionalProperties: false,
      },
    ),
  ]);

  it("applies schema defaults and accepts valid input", () => {
    expect(registry.validate("t", {})).toEqual({ ok: true, input: { days: 7 } });
  });

  it("rejects wrong types, out-of-range values, unknown properties and non-objects", () => {
    expect(registry.validate("t", { days: "7" })).toMatchObject({ ok: false });
    expect(registry.validate("t", { days: 400 })).toMatchObject({ ok: false });
    expect(registry.validate("t", { days: 3, shell: "rm -rf /" })).toMatchObject({ ok: false });
    expect(registry.validate("t", "{days:3}")).toMatchObject({
      ok: false,
      error: "arguments must be a JSON object",
    });
    expect(registry.validate("nope", {})).toMatchObject({ ok: false });
  });

  it("refuses duplicate or non-read-only tools at construction", () => {
    expect(() => new ToolRegistry([stubTool("a"), stubTool("a")])).toThrowError(/duplicate/);
    expect(() => new ToolRegistry([{ ...stubTool("w"), readOnly: false } as never])).toThrowError(
      /read-only/,
    );
  });

  it("compiles the real tools' schemas in strict mode", () => {
    const real = new ToolRegistry([
      costTool({} as never),
      alarmsTool({} as never),
      ciTool({ repository: "o/r" }),
    ] as Tool<never>[]);
    expect(real.specs().map((s) => s.name)).toEqual([
      "get_aws_cost_summary",
      "get_cloudwatch_alarm_status",
      "get_recent_ci_runs",
    ]);
    expect(real.validate("get_cloudwatch_alarm_status", { namePrefix: "a; DROP" })).toMatchObject({
      ok: false,
    });
  });
});

describe("runAgent guardrails", () => {
  it("executes an allowed tool and answers from it", async () => {
    const provider = scripted([[use("cost")], [text("You spent $3.")]]);
    const result = await runAgent(
      provider,
      new ToolRegistry([stubTool("cost", { total: 3 })]),
      "spend?",
    );

    expect(result).toMatchObject({
      answer: "You spent $3.",
      stopReason: "answered",
      iterations: 2,
    });
    expect(executed).toEqual(["cost"]);
    const resultBlock = provider.requests[1]!.messages.at(-1)!.content[0]!;
    expect(resultBlock).toMatchObject({ type: "tool_result", content: '{"total":3}' });
  });

  it("never executes a tool outside the allow-list, and tells the model so", async () => {
    const provider = scripted([[use("delete_bucket", { name: "x" })], [text("I can't do that.")]]);
    const result = await runAgent(provider, new ToolRegistry([stubTool("cost")]), "delete it");

    expect(executed).toEqual([]);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ name: "delete_bucket", status: "rejected" }),
    ]);
    expect(provider.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true });
  });

  it("rejects malformed arguments BEFORE execution", async () => {
    const schema = {
      type: "object" as const,
      properties: { days: { type: "integer" } },
      additionalProperties: false,
    };
    const provider = scripted([[use("cost", { days: "lots" })], [text("sorry")]]);
    const result = await runAgent(
      provider,
      new ToolRegistry([stubTool("cost", {}, schema)]),
      "spend?",
    );

    expect(executed).toEqual([]);
    expect(result.toolCalls[0]!.status).toBe("validation_error");
  });

  it("can never exceed the tool-call cap, even when one turn asks for many tools", async () => {
    const greedy = Array.from({ length: 10 }, (_, i) => use("cost", {}, `c${i}`));
    const provider = scripted([greedy]);
    const result = await runAgent(provider, new ToolRegistry([stubTool("cost")]), "loop", {
      maxToolCalls: 3,
      maxModelTurns: 6,
      maxResultChars: 1000,
    });

    expect(executed).toHaveLength(3);
    expect(result.stopReason).toBe("tool_call_cap");
    expect(result.answer).toBe(CAP_MESSAGE);
  });

  it("stops a model that keeps asking for tools at the model-turn cap", async () => {
    let n = 0;
    const provider: ToolCallingProvider = {
      chat: async () => ({
        model: "m",
        stopReason: "tool_use",
        content: [use("cost", {}, `x${n++}`)],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const result = await runAgent(provider, new ToolRegistry([stubTool("cost")]), "loop", {
      maxToolCalls: 100,
      maxModelTurns: 4,
      maxResultChars: 1000,
    });
    expect(result.stopReason).toBe("model_turn_cap");
    expect(executed).toHaveLength(4);
  });

  it("logs every tool call with name, args, status and duration", async () => {
    await runAgent(
      scripted([[use("cost", {}), use("ghost", { a: 1 })], [text("done")]]),
      new ToolRegistry([stubTool("cost")]),
      "x",
    );
    const calls = logs.filter((l) => l.message === "tool call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toEqual(
        expect.objectContaining({
          tool: expect.any(String),
          args: expect.anything(),
          status: expect.any(String),
          durationMs: expect.any(Number),
        }),
      );
    }
  });

  it("reports a failing tool to the model without the stack, and truncates huge results", async () => {
    const big = "x".repeat(10_000);
    const provider = scripted([[use("boom", {}, "b"), use("big", {}, "g")], [text("ok")]]);
    await runAgent(
      provider,
      new ToolRegistry([stubTool("boom", new Error("AccessDenied")), stubTool("big", big)]),
      "x",
      {
        maxToolCalls: 5,
        maxModelTurns: 3,
        maxResultChars: 100,
      },
    );
    const [failed, truncated] = provider.requests[1]!.messages.at(-1)!.content as Extract<
      ChatBlock,
      { type: "tool_result" }
    >[];
    expect(failed).toMatchObject({ isError: true, content: "The tool failed: AccessDenied" });
    expect(truncated!.content.length).toBeLessThan(150);
  });

  it("runs end to end against the offline fake model, including a refusal", async () => {
    const registry = new ToolRegistry([
      stubTool("get_aws_cost_summary", { total: 4.2, currency: "USD" }),
    ]);
    const spend = await runAgent(
      new FakeToolCallingProvider(),
      registry,
      "How much have I spent on AWS this week?",
    );
    expect(spend.answer).toMatch(/4\.2/);
    const refusal = await runAgent(
      new FakeToolCallingProvider(),
      registry,
      "Terminate the NAT instance",
    );
    expect(refusal.toolCalls).toEqual([]);
    expect(refusal.answer).toMatch(/can't/);
  });
});

describe("real tools against stubbed clients", () => {
  it("summarises Cost Explorer results by service", async () => {
    const client = {
      send: async () => ({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["Amazon EKS"], Metrics: { UnblendedCost: { Amount: "2.4", Unit: "USD" } } },
              { Keys: ["Amazon RDS"], Metrics: { UnblendedCost: { Amount: "0.5", Unit: "USD" } } },
            ],
          },
          {
            Groups: [
              { Keys: ["Amazon EKS"], Metrics: { UnblendedCost: { Amount: "2.4", Unit: "USD" } } },
            ],
          },
        ],
      }),
    };
    const result = (await costTool(client as never).execute({ days: 2 })) as {
      total: number;
      topServices: { service: string }[];
    };
    expect(result.total).toBe(5.3);
    expect(result.topServices[0]!.service).toBe("Amazon EKS");
  });

  it("calls only the configured repository's runs endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ workflow_runs: [{ name: "PR checks", conclusion: "success" }] }),
      );
    }) as unknown as typeof fetch;
    const result = (await ciTool({ repository: "nephast/compass", fetchImpl }).execute({
      limit: 2,
      branch: "main",
    })) as { runs: unknown[] };
    expect(urls[0]).toBe(
      "https://api.github.com/repos/nephast/compass/actions/runs?per_page=2&branch=main",
    );
    expect(result.runs).toHaveLength(1);
  });
});
