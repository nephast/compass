import { S3Client } from "@aws-sdk/client-s3";
import { completionProviderFromEnv, embeddingProviderFromEnv } from "@compass/llm";
import { createPool } from "@compass/pg";
import { logger } from "@compass/telemetry";
import { createAgentClient } from "./agent-client.js";
import { createAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const localstack = process.env.LOCALSTACK_ENDPOINT;
const pool = createPool(process.env, { max: 5 });

const app = buildServer({
  config,
  pool,
  s3: new S3Client(
    localstack
      ? {
          region: process.env.AWS_REGION ?? "eu-west-1",
          endpoint: localstack,
          forcePathStyle: true,
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
        }
      : {},
  ),
  embedder: embeddingProviderFromEnv(),
  completer: completionProviderFromEnv(),
  authenticate: createAuthenticator(config),
  agent: createAgentClient(config.agentToolsUrl),
});

// Graceful shutdown: Kubernetes sends SIGTERM, then removes the pod from the
// Service endpoints *concurrently*, not first. Keep serving briefly so requests
// already routed here complete instead of failing mid-rollout, then drain.
const shutdown = async (signal: string) => {
  logger.info("shutting down", { signal });
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.SHUTDOWN_DELAY_MS ?? 5000)),
  );
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.port });
logger.info("api listening", { port: config.port, authMode: config.authMode });
