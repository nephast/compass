// Every knob the service reads, parsed once at boot. A missing or malformed
// value fails the process before it listens -- a pod that crash-loops on boot
// is caught by the rollout; one that serves 500s on the first query is not.

export type AuthMode = "cognito" | "dev";

export interface ApiConfig {
  port: number;
  documentsBucket: string;
  authMode: AuthMode;
  cognito: { userPoolId: string; clientIds: string[] } | null;
  agentToolsUrl: string;
  rag: { topK: number; maxDistance: number };
  uploadMaxBytes: number;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}="${raw}" is not a number`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const authMode = (env.AUTH_MODE ?? "cognito") as AuthMode;
  if (authMode !== "cognito" && authMode !== "dev") {
    throw new Error(`AUTH_MODE="${String(env.AUTH_MODE)}" must be "cognito" or "dev"`);
  }
  // Dev auth trusts a plain header. It must be impossible to switch on by
  // accident in a cluster, so it also requires a local-only marker.
  if (authMode === "dev" && !env.LOCALSTACK_ENDPOINT) {
    throw new Error("AUTH_MODE=dev is only allowed against LocalStack (LOCALSTACK_ENDPOINT unset)");
  }

  return {
    port: num(env, "PORT", 8080),
    documentsBucket: required(env, "DOCUMENTS_BUCKET"),
    authMode,
    cognito:
      authMode === "cognito"
        ? {
            userPoolId: required(env, "COGNITO_USER_POOL_ID"),
            // Comma-separated: the web client and the smoke-test client.
            clientIds: required(env, "COGNITO_CLIENT_ID")
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          }
        : null,
    agentToolsUrl: env.AGENT_TOOLS_URL ?? "http://agent-tools.compass.svc.cluster.local",
    rag: {
      topK: num(env, "RAG_TOP_K", 5),
      maxDistance: num(env, "RAG_MAX_DISTANCE", 0.75),
    },
    uploadMaxBytes: num(env, "UPLOAD_MAX_BYTES", 5 * 1024 * 1024),
  };
}
