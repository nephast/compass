import { bedrockClient } from "./bedrock/client.js";
import { BedrockCompletionProvider, DEFAULT_COMPLETION_MODEL } from "./bedrock/completions.js";
import { BedrockEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from "./bedrock/embeddings.js";
import { BedrockToolCallingProvider } from "./bedrock/tools.js";
import { DEFAULT_OPENROUTER_MODEL, OpenRouterProvider } from "./openrouter/client.js";
import { FakeCompletionProvider, FakeEmbeddingProvider, FakeToolCallingProvider } from "./fake.js";
import type { CompletionProvider, EmbeddingProvider } from "./types.js";
import type { ToolCallingProvider } from "./tools.js";

export * from "./types.js";
export * from "./tools.js";
export { BedrockEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from "./bedrock/embeddings.js";
export { BedrockCompletionProvider, DEFAULT_COMPLETION_MODEL } from "./bedrock/completions.js";
export { BedrockToolCallingProvider } from "./bedrock/tools.js";
export { OpenRouterProvider, DEFAULT_OPENROUTER_MODEL } from "./openrouter/client.js";
export {
  FakeCompletionProvider,
  FakeEmbeddingProvider,
  FakeToolCallingProvider,
  FAKE_COMPLETION_MODEL,
  FAKE_EMBEDDING_MODEL,
  FAKE_TOOL_MODEL,
} from "./fake.js";

// Selection is by environment variable and nothing else. Callers depend on the
// interfaces in types.ts / tools.ts; only this file and the adapters know a
// vendor exists, which is the property the vendor-containment grep in the
// README checks.
export type ProviderName = "bedrock" | "openrouter" | "fake";

export interface ProviderEnv {
  LLM_EMBEDDING_PROVIDER?: string | undefined;
  LLM_COMPLETION_PROVIDER?: string | undefined;
  LLM_EMBEDDING_MODEL?: string | undefined;
  LLM_COMPLETION_MODEL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  AWS_REGION?: string | undefined;
}

function providerName(value: string | undefined, variable: string): ProviderName {
  // Defaulting to "fake" would let a misspelled provider name silently produce
  // meaningless vectors that pass every row-count check. Fail instead.
  if (value === undefined || value === "") return "bedrock";
  if (value === "bedrock" || value === "openrouter" || value === "fake") return value;
  throw new Error(
    `${variable}="${value}" is not a known provider (expected "bedrock", "openrouter" or "fake")`,
  );
}

export function embeddingProviderFromEnv(env: ProviderEnv = process.env): EmbeddingProvider {
  const name = providerName(env.LLM_EMBEDDING_PROVIDER, "LLM_EMBEDDING_PROVIDER");
  if (name === "fake") return new FakeEmbeddingProvider();
  if (name === "openrouter") {
    // Deliberately unsupported -- see src/openrouter/client.ts and ADR-0006.
    throw new Error(
      "LLM_EMBEDDING_PROVIDER=openrouter is not supported: stored vectors are Titan's, and " +
        "another model's vectors are not comparable with them (ADR-0006)",
    );
  }
  return new BedrockEmbeddingProvider(
    bedrockClient(env.AWS_REGION),
    env.LLM_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
  );
}

function openRouter(env: ProviderEnv): OpenRouterProvider {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("LLM_COMPLETION_PROVIDER=openrouter needs OPENROUTER_API_KEY");
  }
  return new OpenRouterProvider(
    env.OPENROUTER_API_KEY,
    env.LLM_COMPLETION_MODEL ?? DEFAULT_OPENROUTER_MODEL,
  );
}

export function completionProviderFromEnv(env: ProviderEnv = process.env): CompletionProvider {
  const name = providerName(env.LLM_COMPLETION_PROVIDER, "LLM_COMPLETION_PROVIDER");
  if (name === "fake") return new FakeCompletionProvider();
  if (name === "openrouter") return openRouter(env);
  return new BedrockCompletionProvider(
    bedrockClient(env.AWS_REGION),
    env.LLM_COMPLETION_MODEL ?? DEFAULT_COMPLETION_MODEL,
  );
}

/** Same variable as completions: one "which model answers" switch, not two. */
export function toolCallingProviderFromEnv(env: ProviderEnv = process.env): ToolCallingProvider {
  const name = providerName(env.LLM_COMPLETION_PROVIDER, "LLM_COMPLETION_PROVIDER");
  if (name === "fake") return new FakeToolCallingProvider();
  if (name === "openrouter") return openRouter(env);
  return new BedrockToolCallingProvider(
    bedrockClient(env.AWS_REGION),
    env.LLM_COMPLETION_MODEL ?? DEFAULT_COMPLETION_MODEL,
  );
}
