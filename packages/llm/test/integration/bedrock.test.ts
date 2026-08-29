import { describe, it } from "vitest";
import {
  BedrockCompletionProvider,
  BedrockEmbeddingProvider,
  completionProviderFromEnv,
  embeddingProviderFromEnv,
} from "../../src/index.js";
import { bedrockClient } from "../../src/bedrock/client.js";
import {
  completionProviderContract,
  embeddingProviderContract,
} from "../contract/provider-contract.js";

// Opt-in: real Bedrock calls cost money and need credentials, so CI runs the
// same contract against the fake in test/unit and skips this entirely.
//   RUN_LIVE_LLM_TESTS=1 npm run test:integration -w @compass/llm
const live = process.env.RUN_LIVE_LLM_TESTS === "1";

if (live) {
  const client = bedrockClient(process.env.AWS_REGION ?? "eu-west-1");
  embeddingProviderContract("bedrock", () => new BedrockEmbeddingProvider(client));
  completionProviderContract("bedrock", () => new BedrockCompletionProvider(client));

  // The swap itself, asserted rather than described: the same contract passes
  // for both values of the environment variable, with no source file changed.
  embeddingProviderContract("env=bedrock", () =>
    embeddingProviderFromEnv({ LLM_EMBEDDING_PROVIDER: "bedrock", AWS_REGION: "eu-west-1" }),
  );
  completionProviderContract("env=bedrock", () =>
    completionProviderFromEnv({ LLM_COMPLETION_PROVIDER: "bedrock", AWS_REGION: "eu-west-1" }),
  );
} else {
  describe("bedrock live contract", () => {
    it.skip("skipped — set RUN_LIVE_LLM_TESTS=1 to run against real Bedrock", () => {});
  });
}
