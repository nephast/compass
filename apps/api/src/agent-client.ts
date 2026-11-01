import { formatTraceparent, newSpanId, type TraceContext } from "@compass/telemetry";

// The api never runs tools itself; it forwards to agent-tools (a separate
// Deployment with its own IRSA role, so Cost Explorer and CloudWatch
// permissions are never in the api pod -- see ADR-0008). The caller's sub is
// passed for logging and rate attribution only; agent-tools' tools are
// account-level and read-only, so there is no per-user data to scope.

export interface AgentReply {
  answer: string;
  toolCalls: { name: string; status: string; durationMs: number }[];
  iterations: number;
  stopReason: string;
}

export type AgentClient = (
  message: string,
  sub: string,
  trace: TraceContext,
) => Promise<AgentReply>;

export function createAgentClient(baseUrl: string, fetchImpl: typeof fetch = fetch): AgentClient {
  return async (message, sub, trace) => {
    const response = await fetchImpl(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: formatTraceparent({ traceId: trace.traceId, spanId: newSpanId() }),
        "x-compass-user": sub,
      },
      body: JSON.stringify({ message }),
      // Bounded: the agent's own iteration cap (COMPASS-22) bounds its work,
      // this bounds how long the api holds a connection waiting for it.
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`agent-tools returned ${response.status}`);
    return (await response.json()) as AgentReply;
  };
}
