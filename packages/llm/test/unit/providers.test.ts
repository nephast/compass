import { describe, expect, it } from "vitest";
import {
  assertEmbeddingWidths,
  completionProviderFromEnv,
  embeddingProviderFromEnv,
  EmbeddingWidthError,
  EMBEDDING_DIMENSIONS,
  FakeCompletionProvider,
  FakeEmbeddingProvider,
  FAKE_EMBEDDING_MODEL,
} from "../../src/index.js";
import {
  completionProviderContract,
  embeddingProviderContract,
} from "../contract/provider-contract.js";

// No network, no credentials -- this tier runs in CI and on every save. The
// same contract runs against Bedrock in test/integration.
embeddingProviderContract("fake", () => new FakeEmbeddingProvider());
completionProviderContract("fake", () => new FakeCompletionProvider());

describe("assertEmbeddingWidths", () => {
  it("names the model, the expected width and the actual width", () => {
    const wrong = { model: "stub-1536", vectors: [new Array<number>(1536).fill(0)] };
    expect(() => assertEmbeddingWidths(wrong, EMBEDDING_DIMENSIONS)).toThrowError(
      EmbeddingWidthError,
    );
    // The point of the error is that a human reading it knows what to change,
    // so assert the message carries both numbers rather than just the type.
    expect(() => assertEmbeddingWidths(wrong, EMBEDDING_DIMENSIONS)).toThrowError(/1536/);
    expect(() => assertEmbeddingWidths(wrong, EMBEDDING_DIMENSIONS)).toThrowError(/1024/);
  });

  it("reports which input was wrong, not just that one was", () => {
    const wrong = {
      model: "stub-mixed",
      vectors: [new Array<number>(1024).fill(0), new Array<number>(512).fill(0)],
    };
    try {
      assertEmbeddingWidths(wrong, EMBEDDING_DIMENSIONS);
      expect.unreachable("expected an EmbeddingWidthError");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingWidthError);
      expect((error as EmbeddingWidthError).index).toBe(1);
    }
  });
});

describe("provider selection from the environment", () => {
  it("selects the fake with no source change", async () => {
    const provider = embeddingProviderFromEnv({ LLM_EMBEDDING_PROVIDER: "fake" });
    const result = await provider.embed(["hello"]);
    expect(result.model).toBe(FAKE_EMBEDDING_MODEL);
  });

  it("defaults to bedrock when unset", () => {
    // Defaulting to the fake would be far worse: a missing variable in a
    // deployed environment would fill the database with meaningless vectors
    // while every row count and every health check stayed green.
    const provider = embeddingProviderFromEnv({ AWS_REGION: "eu-west-1" });
    expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(provider).not.toBeInstanceOf(FakeEmbeddingProvider);
  });

  it("rejects an unknown provider name instead of falling back", () => {
    expect(() => embeddingProviderFromEnv({ LLM_EMBEDDING_PROVIDER: "bedrok" })).toThrowError(
      /bedrok/,
    );
    expect(() => completionProviderFromEnv({ LLM_COMPLETION_PROVIDER: "openai" })).toThrowError(
      /openai/,
    );
  });
});
