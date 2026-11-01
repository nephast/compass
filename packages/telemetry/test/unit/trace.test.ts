import { describe, expect, it, vi } from "vitest";
import { logger, withLogContext } from "../../src/logger.js";
import { formatTraceparent, parseTraceparent, resolveTrace } from "../../src/trace.js";

const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("trace propagation", () => {
  it("continues an incoming traceparent with a new span", () => {
    const resolved = resolveTrace({ traceparent: valid });
    expect(resolved.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(resolved.spanId).not.toBe("00f067aa0ba902b7");
    expect(parseTraceparent(formatTraceparent(resolved))).toEqual(resolved);
  });

  it("rejects malformed and all-zero traceparents", () => {
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
  });

  it("derives a stable trace id from the gateway request id", () => {
    const a = resolveTrace({ "x-request-id": "Rq3abc=" });
    const b = resolveTrace({ "x-request-id": "Rq3abc=" });
    expect(a.traceId).toBe(b.traceId);
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("logger", () => {
  it("emits one JSON line carrying the request context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    withLogContext({ traceId: "t-1" }, () => logger.info("hello", { err: new Error("boom") }));
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: "info", message: "hello", traceId: "t-1" });
    expect(line.err.message).toBe("boom");
    spy.mockRestore();
  });
});
