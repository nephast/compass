import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  assertEmbeddableTexts,
  assertEmbeddingWidths,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "../types.js";

// Titan Text Embeddings V2 is ON_DEMAND, so the bare model id is correct here.
// Contrast the completion adapter, where Claude is INFERENCE_PROFILE-only and
// the bare id is rejected.
export const DEFAULT_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

// Titan accepts ONE `inputText` per call -- there is no batch form -- so a
// document's chunks fan out into one request each. Capped rather than
// Promise.all over the whole array: a 200-chunk document would otherwise open
// 200 concurrent connections and earn a throttling response.
const MAX_CONCURRENT_REQUESTS = 8;

interface TitanEmbeddingResponse {
  embedding: number[];
  inputTextTokenCount: number;
}

export class BedrockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string = DEFAULT_EMBEDDING_MODEL,
  ) {}

  async embed(texts: string[]): Promise<EmbeddingResult> {
    assertEmbeddableTexts(texts);
    const vectors: number[][] = new Array<number[]>(texts.length);

    for (let start = 0; start < texts.length; start += MAX_CONCURRENT_REQUESTS) {
      const batch = texts.slice(start, start + MAX_CONCURRENT_REQUESTS);
      const embedded = await Promise.all(batch.map((text) => this.embedOne(text)));
      embedded.forEach((vector, offset) => {
        vectors[start + offset] = vector;
      });
    }

    return assertEmbeddingWidths({ model: this.modelId, vectors }, this.dimensions);
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text,
          // Requested explicitly rather than relying on the model default, so
          // the schema's width is stated at the call site (ADR-0006). Titan V2
          // also offers 512 and 256.
          dimensions: EMBEDDING_DIMENSIONS,
          // The retrieval index uses cosine distance (`<=>`), which compares
          // direction and ignores magnitude. Normalising here means stored
          // vectors are already unit length, so that comparison is well behaved
          // and distances stay comparable across documents.
          normalize: true,
        }),
      }),
    );

    const parsed = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as Partial<TitanEmbeddingResponse>;

    if (!Array.isArray(parsed.embedding)) {
      throw new Error(
        `Bedrock model ${this.modelId} returned no embedding array — ` +
          `response keys were [${Object.keys(parsed).join(", ")}]`,
      );
    }
    return parsed.embedding;
  }
}
