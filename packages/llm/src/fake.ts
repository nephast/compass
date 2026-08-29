import {
  assertEmbeddableTexts,
  assertEmbeddingWidths,
  EMBEDDING_DIMENSIONS,
  type CompletionProvider,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./types.js";

// Not a test fixture. With one real vendor this is the SECOND implementation of
// each interface, and therefore the only thing that demonstrates the seam holds
// rather than asserting it -- the contract suite runs against both. It also
// lets apps/ingestion and apps/api be tested with no credentials and no spend.

export const FAKE_EMBEDDING_MODEL = "fake-hashed-bag-of-words";
export const FAKE_COMPLETION_MODEL = "fake-echo";

/** FNV-1a. Any stable hash works; this one is short and dependency-free. */
function hash(token: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    value ^= token.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * A hashed bag of words, unit normalised. Deliberately NOT random noise: two
 * texts sharing vocabulary land close together and unrelated texts do not, so
 * the contract suite's "related is nearer than unrelated" check is meaningful
 * against this provider and against Bedrock, with no special-casing. It models
 * lexical similarity, not semantic similarity -- which is exactly why it is a
 * test double and not a retrieval strategy.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(private readonly model: string = FAKE_EMBEDDING_MODEL) {}

  // `async` deliberately: a synchronous throw here would diverge from the
  // Bedrock adapter, where the same guard surfaces as a rejected promise.
  async embed(texts: string[]): Promise<EmbeddingResult> {
    assertEmbeddableTexts(texts);
    const vectors = texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const token of tokenize(text)) {
        const index = hash(token) % this.dimensions;
        // Sign from a second bit of the hash, so tokens colliding on the same
        // index do not always reinforce each other.
        // `?? 0` for noUncheckedIndexedAccess: the array is pre-filled, so this
        // is never actually undefined.
        vector[index] = (vector[index] ?? 0) + (hash(`${token}#`) % 2 === 0 ? 1 : -1);
      }
      const norm = Math.hypot(...vector);
      // An empty or punctuation-only input has no tokens; return a fixed unit
      // vector rather than dividing by zero and emitting NaNs, which would fail
      // far away from the cause.
      if (norm === 0) {
        vector[0] = 1;
        return vector;
      }
      return vector.map((value) => value / norm);
    });

    return assertEmbeddingWidths({ model: this.model, vectors }, this.dimensions);
  }
}

/** Deterministic and offline: echoes the last user message with a marker. */
export class FakeCompletionProvider implements CompletionProvider {
  constructor(private readonly model: string = FAKE_COMPLETION_MODEL) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMessage?.content ?? "";
    const inputTokens = request.messages.reduce((sum, m) => sum + tokenize(m.content).length, 0);
    const text = `[fake] ${prompt}`;

    return {
      model: this.model,
      text,
      usage: { inputTokens, outputTokens: tokenize(text).length },
    };
  }
}
