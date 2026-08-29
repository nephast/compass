import { bedrockClient } from "./bedrock/client.js";
import { BedrockCompletionProvider, DEFAULT_COMPLETION_MODEL } from "./bedrock/completions.js";
import { BedrockEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from "./bedrock/embeddings.js";
import { FakeCompletionProvider, FakeEmbeddingProvider } from "./fake.js";
import type { CompletionProvider, EmbeddingProvider } from "./types.js";

export * from "./types.js";
export { BedrockEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from "./bedrock/embeddings.js";
export { BedrockCompletionProvider, DEFAULT_COMPLETION_MODEL } from "./bedrock/completions.js";
export {
  FakeCompletionProvider,
  FakeEmbeddingProvider,
  FAKE_COMPLETION_MODEL,
  FAKE_EMBEDDING_MODEL,
} from "./fake.js";

// Selection is by environment variable and nothing else. Callers depend on the
// interfaces in types.ts; only this file and the adapters know a vendor exists,
// which is the property the vendor-containment grep in the README checks.
export type ProviderName = "bedrock" | "fake";

export interface ProviderEnv {
  LLM_EMBEDDING_PROVIDER?: string | undefined;
  LLM_COMPLETION_PROVIDER?: string | undefined;
  LLM_EMBEDDING_MODEL?: string | undefined;
  LLM_COMPLETION_MODEL?: string | undefined;
  AWS_REGION?: string | undefined;
}

function providerName(value: string | undefined, variable: string): ProviderName {
  // Defaulting to "fake" would let a misspelled provider name silently produce
  // meaningless vectors that pass every row-count check. Fail instead.
  if (value === undefined || value === "") return "bedrock";
  if (value === "bedrock" || value === "fake") return value;
  throw new Error(`${variable}="${value}" is not a known provider (expected "bedrock" or "fake")`);
}

export function embeddingProviderFromEnv(env: ProviderEnv = process.env): EmbeddingProvider {
  const name = providerName(env.LLM_EMBEDDING_PROVIDER, "LLM_EMBEDDING_PROVIDER");
  if (name === "fake") return new FakeEmbeddingProvider();
  return new BedrockEmbeddingProvider(
    bedrockClient(env.AWS_REGION),
    env.LLM_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
  );
}

export function completionProviderFromEnv(env: ProviderEnv = process.env): CompletionProvider {
  const name = providerName(env.LLM_COMPLETION_PROVIDER, "LLM_COMPLETION_PROVIDER");
  if (name === "fake") return new FakeCompletionProvider();
  return new BedrockCompletionProvider(
    bedrockClient(env.AWS_REGION),
    env.LLM_COMPLETION_MODEL ?? DEFAULT_COMPLETION_MODEL,
  );
}
