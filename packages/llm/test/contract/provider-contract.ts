import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  type CompletionProvider,
  type EmbeddingProvider,
} from "../../src/index.js";

// ONE suite, parameterised over implementations. Adding a provider means adding
// it to a parameter list, not writing a second test file that can drift from
// this one. Not named *.test.ts on purpose: vitest collects test files, and
// this is a library the tiers import.

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function embeddingProviderContract(name: string, create: () => EmbeddingProvider): void {
  describe(`EmbeddingProvider contract: ${name}`, () => {
    it("returns one vector per input, in input order", async () => {
      const result = await create().embed(["alpha document", "beta document", "gamma document"]);
      expect(result.vectors).toHaveLength(3);
      // Order matters more than it looks: chunks are stored against their
      // ordinal, so a provider that reorders silently attaches every embedding
      // to the wrong chunk, and retrieval degrades with nothing failing. Embed
      // the middle input alone and check it landed in slot 1.
      const single = await create().embed(["beta document"]);
      expect(cosineDistance(result.vectors[1]!, single.vectors[0]!)).toBeLessThan(1e-6);
    });

    it(`returns vectors of exactly ${EMBEDDING_DIMENSIONS} dimensions`, async () => {
      const result = await create().embed(["a short document"]);
      expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(create().dimensions).toBe(EMBEDDING_DIMENSIONS);
    });

    it("reports the model that produced the vectors", async () => {
      const result = await create().embed(["a short document"]);
      expect(result.model).toBeTruthy();
    });

    it("places related texts nearer than unrelated ones", async () => {
      // The criterion that catches an adapter which "works" -- right shape, right
      // count, right width -- but misparses the response and returns constants
      // or noise. Row counts cannot detect that; distance can.
      const result = await create().embed([
        "the cat sat on the mat in the kitchen",
        "a cat was sitting on a mat in the kitchen",
        "quarterly amortisation of deferred tax liabilities",
      ]);
      const related = cosineDistance(result.vectors[0]!, result.vectors[1]!);
      const unrelated = cosineDistance(result.vectors[0]!, result.vectors[2]!);
      expect(related).toBeLessThan(unrelated);
    });

    it("rejects an empty chunk rather than embedding nothing", async () => {
      // Titan refuses an empty string (minLength: 1). Making every provider
      // refuse it too keeps the behaviour uniform, and puts the failure where
      // it can name the offending input -- an empty chunk is a chunker bug.
      await expect(create().embed(["fine", "   "])).rejects.toThrowError(/empty or whitespace/);
    });

    it("produces no NaN for text with no alphanumeric tokens", async () => {
      // A chunk of pure punctuation is embeddable but has nothing to hash. NaN
      // in a stored vector makes every later distance NaN, and that failure
      // surfaces a long way from its cause.
      const result = await create().embed(["...", "---"]);
      for (const vector of result.vectors) {
        expect(vector.every((value) => Number.isFinite(value))).toBe(true);
      }
    });

    it("returns nothing for no inputs", async () => {
      const result = await create().embed([]);
      expect(result.vectors).toEqual([]);
    });
  });
}

export function completionProviderContract(name: string, create: () => CompletionProvider): void {
  describe(`CompletionProvider contract: ${name}`, () => {
    it("returns text, the resolved model, and token usage", async () => {
      const result = await create().complete({
        messages: [{ role: "user", content: "Say the word ok." }],
        maxTokens: 16,
      });
      expect(result.text).toBeTruthy();
      expect(result.model).toBeTruthy();
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    });

    it("accepts a system prompt", async () => {
      const result = await create().complete({
        system: "You are terse.",
        messages: [{ role: "user", content: "Say the word ok." }],
        maxTokens: 16,
      });
      expect(result.text).toBeTruthy();
    });

    it("accepts a multi-turn conversation", async () => {
      const result = await create().complete({
        messages: [
          { role: "user", content: "My favourite colour is green." },
          { role: "assistant", content: "Noted." },
          { role: "user", content: "What is my favourite colour?" },
        ],
        maxTokens: 32,
      });
      expect(result.text).toBeTruthy();
    });
  });
}
