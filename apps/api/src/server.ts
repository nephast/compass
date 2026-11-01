import type { S3Client } from "@aws-sdk/client-s3";
import type { CompletionProvider, EmbeddingProvider } from "@compass/llm";
import type { Pool } from "@compass/pg";
import {
  addLogContext,
  enterLogContext,
  logContext,
  logger,
  resolveTrace,
  type TraceContext,
} from "@compass/telemetry";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Authenticate, Caller } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { listDocuments } from "./documents.js";
import { answerQuestion } from "./rag.js";
import {
  buildUploadKey,
  presignUpload,
  sanitiseFileName,
  UPLOAD_URL_TTL_SECONDS,
  validateUpload,
} from "./uploads.js";

export interface ApiDeps {
  config: ApiConfig;
  pool: Pool;
  s3: S3Client;
  embedder: EmbeddingProvider;
  completer: CompletionProvider;
  authenticate: Authenticate;
}

declare module "fastify" {
  interface FastifyRequest {
    caller: Caller;
    trace: TraceContext;
    startedAt: number;
  }
}

// Routes are versionless on purpose: the only client is the frontend in this
// repo, deployed from the same commit. A /v1 prefix would be ceremony.
export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: false, // @compass/telemetry is the one log format (COMPASS-29)
    bodyLimit: 16 * 1024,
    // Behind API Gateway + ALB; the client address arrives in x-forwarded-for.
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });

  app.decorateRequest("caller", null as unknown as Caller);
  app.decorateRequest("trace", null as unknown as TraceContext);
  app.decorateRequest("startedAt", 0);

  app.addHook("onRequest", async (request) => {
    request.startedAt = Date.now();
    request.trace = resolveTrace(request.headers);
    enterLogContext({ traceId: request.trace.traceId, requestId: request.id });
  });

  // In AWS, API Gateway answers CORS preflights (infra/cdk ApiStack) and the
  // service never sees them. Locally the browser talks to this process
  // directly, so dev mode -- and only dev mode -- answers for localhost:3000.
  if (deps.config.authMode === "dev") {
    app.addHook("onRequest", async (request, reply) => {
      void reply.header("access-control-allow-origin", "http://localhost:3000");
      void reply.header("access-control-allow-headers", "content-type, x-dev-user, traceparent");
      void reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      if (request.method === "OPTIONS") return reply.status(204).send();
    });
  }

  const publicRoutes = new Set(["/healthz"]);
  app.addHook("preHandler", async (request) => {
    if (publicRoutes.has(request.routeOptions.url ?? "")) return;
    request.caller = await deps.authenticate(request.headers);
    addLogContext({ user: request.caller.sub });
  });

  // One line per request with the fields the dashboard aggregates on
  // (COMPASS-29): route template (not raw URL, so ids do not explode the
  // cardinality), status, duration. Health checks are skipped -- at one probe
  // every few seconds per pod they would be most of the log volume and bill.
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === "/healthz" || request.method === "OPTIONS") return;
    logger.info("request completed", {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
      durationMs: Date.now() - request.startedAt,
    });
  });

  app.setErrorHandler(
    (error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
      const status = error.statusCode ?? 500;
      if (status >= 500)
        logger.error("request failed", { err: error, route: request.routeOptions.url });
      // 4xx carry their message (they are the caller's to fix); 5xx never leak
      // internals, but always carry the trace id to quote in a bug report.
      void reply.status(status).send({
        error: status >= 500 ? "internal error" : error.message,
        traceId: logContext().traceId ?? request.trace?.traceId,
      });
    },
  );

  // Liveness and readiness both point here and it deliberately touches no
  // dependency: a database blip must not make Kubernetes kill every pod at
  // once, which turns a dependency outage into a total one.
  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Body: { fileName: string; size: number; contentType?: string } }>(
    "/documents/upload-url",
    {
      schema: {
        body: {
          type: "object",
          required: ["fileName", "size"],
          additionalProperties: false,
          properties: {
            fileName: { type: "string", minLength: 1, maxLength: 255 },
            size: { type: "integer", minimum: 1 },
            contentType: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (request) => {
      const { fileName, size } = request.body;
      const name = sanitiseFileName(fileName);
      validateUpload(name, size, deps.config.uploadMaxBytes);
      const contentType = name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown";
      const key = buildUploadKey(request.caller.sub, name);
      const url = await presignUpload(deps.s3, deps.config.documentsBucket, key, size, contentType);
      logger.info("upload presigned", { key, size });
      return {
        url,
        key,
        method: "PUT",
        headers: { "content-type": contentType },
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      };
    },
  );

  app.get("/documents", async (request: FastifyRequest) => ({
    documents: await listDocuments(deps.pool, request.caller.sub),
  }));

  app.post<{ Body: { question: string } }>(
    "/query",
    {
      schema: {
        body: {
          type: "object",
          required: ["question"],
          additionalProperties: false,
          properties: { question: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request) =>
      answerQuestion(deps, request.caller.sub, request.body.question.trim(), deps.config.rag),
  );

  return app;
}
