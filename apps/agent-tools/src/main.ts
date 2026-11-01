import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { toolCallingProviderFromEnv } from "@compass/llm";
import { logger } from "@compass/telemetry";
import { DEFAULT_LIMITS } from "./agent.js";
import { ToolRegistry } from "./registry.js";
import { buildServer } from "./server.js";
import { alarmsTool } from "./tools/alarms.js";
import { ciTool } from "./tools/ci.js";
import { costTool } from "./tools/cost.js";
import type { Tool } from "./tools/types.js";

// Secrets come from Secrets Manager at boot, through the pod's IRSA role --
// never from a Kubernetes Secret or the manifest (ARCHITECTURE.md). The secret
// is a JSON object; both keys are optional.
async function loadSecrets(): Promise<{ OPENROUTER_API_KEY?: string; GITHUB_TOKEN?: string }> {
  const secretId = process.env.AGENT_SECRET_ID;
  if (!secretId) return {};
  const response = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  return JSON.parse(response.SecretString ?? "{}") as Record<string, string>;
}

const secrets = await loadSecrets();
const env = { ...process.env, ...secrets };

const tools: Tool<never>[] = [
  costTool() as Tool<never>,
  alarmsTool() as Tool<never>,
  ciTool({
    repository: process.env.GITHUB_REPOSITORY ?? "nephast/compass",
    token: env.GITHUB_TOKEN,
  }) as Tool<never>,
];

const registry = new ToolRegistry(tools);
const app = buildServer(toolCallingProviderFromEnv(env), registry, {
  ...DEFAULT_LIMITS,
  maxToolCalls: Number(process.env.AGENT_MAX_TOOL_CALLS ?? DEFAULT_LIMITS.maxToolCalls),
});

const shutdown = async (signal: string) => {
  logger.info("shutting down", { signal });
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.SHUTDOWN_DELAY_MS ?? 5000)),
  );
  await app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });
logger.info("agent-tools listening", { port, tools: registry.specs().map((s) => s.name) });
