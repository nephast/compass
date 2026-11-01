import { randomBytes } from "node:crypto";

// One trace id, carried from the edge to the last log line (COMPASS-31).
//
// W3C `traceparent` is the wire format between our own services because it is
// what OpenTelemetry speaks, so adding a collector later changes nothing here.
// API Gateway HTTP APIs do not mint a traceparent, but they do stamp every
// request with a request id; the gateway's parameter mapping forwards it as
// `x-request-id`, and when no traceparent arrives we derive the trace id from
// it. That is what makes one request findable in the gateway's access log and
// in every service's logs with a single Logs Insights query on `traceId`.

export interface TraceContext {
  traceId: string;
  spanId: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function parseTraceparent(header: string | undefined): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, traceId, spanId] = match as unknown as [string, string, string];
  // All-zero ids are explicitly invalid in the spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId };
}

/** A 32-hex trace id derived deterministically from any request id string. */
export function traceIdFromRequestId(requestId: string): string {
  const hex = Buffer.from(requestId)
    .toString("hex")
    .replace(/[^0-9a-f]/g, "");
  return (hex + "0".repeat(32)).slice(0, 32);
}

export function resolveTrace(headers: Record<string, string | string[] | undefined>): TraceContext {
  const first = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const parent = parseTraceparent(first("traceparent"));
  if (parent) return { traceId: parent.traceId, spanId: newSpanId() };
  const requestId = first("x-request-id");
  return {
    traceId: requestId ? traceIdFromRequestId(requestId) : randomBytes(16).toString("hex"),
    spanId: newSpanId(),
  };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}
