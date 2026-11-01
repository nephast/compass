import type { ToolCallingProvider } from "@compass/llm";
import { enterLogContext, logger, resolveTrace } from "@compass/telemetry";
import Fastify, { type FastifyInstance } from "fastify";
import { runAgent, type AgentLimits } from "./agent.js";
import type { ToolRegistry } from "./registry.js";

// Internal only: a ClusterIP Service with a NetworkPolicy admitting the api
// pods and nothing else (infra/k8s). There is no auth here because there is
// no route to it from outside the cluster; the api has already verified the
// caller, and these tools read account-level data, not per-user data.
export function buildServer(
  provider: ToolCallingProvider,
  registry: ToolRegistry,
  limits: AgentLimits,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.addHook("onRequest", async (request) => {
    const trace = resolveTrace(request.headers);
    const user = request.headers["x-compass-user"];
    enterLogContext({
      traceId: trace.traceId,
      requestId: request.id,
      ...(typeof user === "string" ? { user } : {}),
    });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) logger.error("request failed", { err: error });
    void reply.status(status).send({ error: status >= 500 ? "internal error" : error.message });
  });

  app.get("/healthz", async () => ({ status: "ok", tools: registry.specs().map((s) => s.name) }));

  app.post<{ Body: { message: string } }>(
    "/v1/chat",
    {
      schema: {
        body: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: { message: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request) => {
      const started = Date.now();
      const result = await runAgent(provider, registry, request.body.message, limits);
      logger.info("agent completed", {
        iterations: result.iterations,
        toolCalls: result.toolCalls.length,
        stopReason: result.stopReason,
        model: result.model,
        durationMs: Date.now() - started,
      });
      return result;
    },
  );

  return app;
}
