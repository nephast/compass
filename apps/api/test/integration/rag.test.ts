// RAG against real pgvector: real SQL, real HNSW index, real owner scoping.
// Vectors come from the offline embedder, so no Bedrock and no spend.
//
// Requires: npm run local:up
import { randomUUID } from "node:crypto";
import {
  FakeCompletionProvider,
  FakeEmbeddingProvider,
  type CompletionProvider,
} from "@compass/llm";
import { createPool } from "@compass/pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDocuments } from "../../src/documents.js";
import { answerQuestion, NOT_FOUND_ANSWER, retrieve } from "../../src/rag.js";

const pool = createPool();
const embedder = new FakeEmbeddingProvider();
const owner = `owner-${randomUUID()}`;
const stranger = `stranger-${randomUUID()}`;
const bucket = `rag-test-${randomUUID()}`;
// Bag-of-words distances run higher than Titan's; the threshold is per model.
const options = { topK: 4, maxDistance: 0.9 };

async function seed(ownerSub: string, fileName: string, chunks: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents (bucket, object_key, content_hash, status, owner_sub, file_name)
     VALUES ($1, $2, $3, 'embedded', $4, $5) RETURNING id`,
    [bucket, `uploads/${ownerSub}/${randomUUID()}/${fileName}`, randomUUID(), ownerSub, fileName],
  );
  const documentId = rows[0]!.id;
  const { vectors, model } = await embedder.embed(chunks);
  for (const [ordinal, content] of chunks.entries()) {
    const { rows: c } = await pool.query<{ id: string }>(
      "INSERT INTO chunks (document_id, ordinal, content) VALUES ($1, $2, $3) RETURNING id",
      [documentId, ordinal, content],
    );
    await pool.query(
      "INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)",
      [c[0]!.id, model, `[${vectors[ordinal]!.join(",")}]`],
    );
  }
  return documentId;
}

beforeAll(async () => {
  await seed(owner, "runbook.md", [
    "The deploy pipeline builds images and pushes them to ECR.",
    "To roll back a bad deploy run kubectl rollout undo deployment api in namespace compass.",
    "Rollback completes in about thirty seconds because the previous replica set is kept.",
    "Unrelated appendix about office plants and watering schedules.",
  ]);
  await seed(stranger, "secret.md", [
    "The stranger's rollback secret is kubectl rollout undo banana.",
  ]);
});

afterAll(async () => {
  await pool.query("DELETE FROM documents WHERE bucket = $1", [bucket]);
  await pool.end();
});

describe("retrieval", () => {
  it("returns only the caller's chunks, nearest first", async () => {
    const { hits } = await retrieve(
      { pool, embedder },
      owner,
      "how do I roll back with kubectl rollout undo",
      10,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.fileName === "runbook.md")).toBe(true);
    expect(hits[0]!.content).toMatch(/rollout undo/);
    const distances = hits.map((h) => h.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });
});

describe("answerQuestion", () => {
  it("answers with citations that point at the source document, widened by neighbours", async () => {
    const result = await answerQuestion(
      { pool, embedder, completer: new FakeCompletionProvider() },
      owner,
      "how do I roll back with kubectl rollout undo",
      options,
    );
    expect(result.grounded).toBe(true);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.fileName).toBe("runbook.md");
    expect(result.citations[0]!.ordinals).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(result.citations[0]!.excerpt).toMatch(/rollout undo/);
  });

  it("says so instead of answering when nothing relevant exists — without calling the model", async () => {
    let called = false;
    const completer: CompletionProvider = {
      complete: async () => {
        called = true;
        throw new Error("must not be called");
      },
    };
    const result = await answerQuestion(
      { pool, embedder, completer },
      owner,
      "zebra quantum lasagne",
      options,
    );
    expect(result).toEqual({
      answer: NOT_FOUND_ANSWER,
      grounded: false,
      citations: [],
      model: null,
    });
    expect(called).toBe(false);
  });

  it("returns no citations when the model reports the answer is not in the passages", async () => {
    const completer: CompletionProvider = {
      complete: async () => ({
        model: "m",
        text: NOT_FOUND_ANSWER,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const result = await answerQuestion(
      { pool, embedder, completer },
      owner,
      "kubectl rollout undo",
      options,
    );
    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
  });
});

describe("listDocuments", () => {
  it("lists only the caller's documents", async () => {
    const documents = await listDocuments(pool, owner);
    expect(documents.map((d) => d.fileName)).toEqual(["runbook.md"]);
    expect(documents[0]!.chunks).toBe(4);
  });
});
