// The interface is split in two because completions and embeddings have
// fundamentally different relationships to persisted state (ADR-0006):
// a completion is stateless text-in/text-out, so swapping its model is a
// configuration change; an embedding is written to a fixed-width column and is
// only comparable against vectors from the same model, so swapping it is a
// migration plus a full re-embed. A single fused interface would assert a
// symmetry that does not exist, and would make "Bedrock for embeddings,
// something else for completions" -- a likely configuration -- inexpressible.

/**
 * Fixed by the schema: `embeddings.embedding` is `VECTOR(1024)`. Changing this
 * is a migration and a re-embed of the whole corpus, never a constant edit.
 * See ADR-0006.
 */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingResult {
  /**
   * The model that actually produced these vectors, not the one configuration
   * asked for. `embeddings.model` records provenance, and a provider that
   * silently substitutes a model must not be able to hide it.
   */
  model: string;
  vectors: number[][];
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  /** Vectors are returned in the same order as `texts`. */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface CompletionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system?: string;
  messages: CompletionMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  model: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CompletionProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Thrown where the vector is produced, not where Postgres rejects it. A width
 * mismatch three layers down surfaces as a driver error mentioning neither the
 * model nor the expected width; here it names both (ADR-0006, action item 3).
 */
export class EmbeddingWidthError extends Error {
  constructor(
    readonly model: string,
    readonly expected: number,
    readonly actual: number,
    readonly index: number,
  ) {
    super(
      `embedding provider "${model}" returned ${actual} dimensions for input ${index}, ` +
        `expected ${expected} — the embeddings.embedding column is VECTOR(${expected}) ` +
        `(ADR-0006); changing it is a migration, not a config edit`,
    );
    this.name = "EmbeddingWidthError";
  }
}

/**
 * Titan rejects an empty string (`minLength: 1`), so an empty chunk would fail
 * at the vendor with a message naming neither the chunk nor the document. Every
 * adapter applies this first so the behaviour is uniform: an unembeddable chunk
 * is a caller bug, and the caller -- the chunker -- must never emit one.
 */
export class EmptyEmbeddingInputError extends Error {
  constructor(readonly index: number) {
    super(
      `embedding input ${index} is empty or whitespace-only; chunks must carry text ` +
        `before they reach a provider`,
    );
    this.name = "EmptyEmbeddingInputError";
  }
}

export function assertEmbeddableTexts(texts: string[]): void {
  texts.forEach((text, index) => {
    if (text.trim() === "") throw new EmptyEmbeddingInputError(index);
  });
}

/** Applied by every adapter, so no implementation can skip the check. */
export function assertEmbeddingWidths(result: EmbeddingResult, expected: number): EmbeddingResult {
  result.vectors.forEach((vector, index) => {
    if (vector.length !== expected) {
      throw new EmbeddingWidthError(result.model, expected, vector.length, index);
    }
  });
  return result;
}
