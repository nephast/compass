// Fast tier: the real pipeline, in this process, against real LocalStack S3
// and real Postgres/pgvector, with the offline embedder (vitest.config.ts) --
// no Lambda deploy, no Bedrock spend. This is the loop you run on every save.
// The deploy path is proved separately in test/wiring.
//
// Requires: npm run local:up
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { FAKE_EMBEDDING_MODEL, type EmbeddingProvider } from "@compass/llm";
import { createPool } from "@compass/pg";
import { handler } from "../../src/on-object-created.js";
import { ingestObject } from "../../src/ingest.js";
import { getObject } from "../../src/s3-objects.js";
import { createBucket, deleteBucket, s3 } from "../helpers/localstack.js";
import { s3Event } from "../helpers/s3-event-fixture.js";

const bucket = `compass-ingestion-test-${randomUUID()}`;
const pool = createPool();

beforeAll(() => createBucket(bucket));

afterAll(async () => {
  try {
    await deleteBucket(bucket);
    // chunks and embeddings cascade from documents.
    await pool.query("DELETE FROM documents WHERE bucket = $1", [bucket]);
  } finally {
    await pool.end();
  }
});

async function put(key: string, body: string | Uint8Array): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

const run = (key: string) => handler(s3Event(bucket, key));

// ~12 paragraphs of distinct prose, comfortably over several 1000-char chunks.
const topics = ["volcanoes", "databases", "orchids", "glaciers", "sailing", "compilers"];
const multiPage = topics
  .flatMap((topic, i) => [
    `Section ${i}: ${topic}. ` +
      `This paragraph is entirely about ${topic} and ${topic} alone. `.repeat(8),
    `More on ${topic}: ` + `facts about ${topic} keep accumulating in this section. `.repeat(8),
  ])
  .join("\n\n");

async function counts(key: string) {
  const { rows } = await pool.query<{ documents: number; chunks: number; embeddings: number }>(
    `SELECT
       (SELECT count(*)::int FROM documents d WHERE d.bucket = $1 AND d.object_key = $2) AS documents,
       (SELECT count(*)::int FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.bucket = $1 AND d.object_key = $2) AS chunks,
       (SELECT count(*)::int FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE d.bucket = $1 AND d.object_key = $2) AS embeddings`,
    [bucket, key],
  );
  return rows[0]!;
}

describe("ingestion pipeline", () => {
  it("chunks and embeds a multi-page document into contiguous ordinals", async () => {
    const key = `docs/${randomUUID()}.md`;
    await put(key, multiPage);

    await run(key);

    const c = await counts(key);
    expect(c.documents).toBe(1);
    expect(c.chunks).toBeGreaterThan(1);
    expect(c.embeddings).toBe(c.chunks);

    const { rows } = await pool.query<{ ordinal: number; model: string; status: string }>(
      `SELECT c.ordinal, e.model, d.status FROM documents d
         JOIN chunks c ON c.document_id = d.id JOIN embeddings e ON e.chunk_id = c.id
        WHERE d.bucket = $1 AND d.object_key = $2 ORDER BY c.ordinal`,
      [bucket, key],
    );
    expect(rows.map((r) => r.ordinal)).toEqual([...Array(rows.length).keys()]);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set([FAKE_EMBEDDING_MODEL]));
    expect(rows[0]!.status).toBe("embedded");
  });

  it("stores genuine vectors: self-distance 0, distinct chunks non-zero apart", async () => {
    const key = `docs/${randomUUID()}.md`;
    await put(key, multiPage);
    await run(key);

    const { rows } = await pool.query<{ self: number; between: number }>(
      `WITH v AS (
         SELECT c.ordinal, e.embedding FROM documents d
           JOIN chunks c ON c.document_id = d.id JOIN embeddings e ON e.chunk_id = c.id
          WHERE d.bucket = $1 AND d.object_key = $2)
       SELECT (SELECT a.embedding <=> a.embedding FROM v a WHERE a.ordinal = 0) AS self,
              (SELECT a.embedding <=> b.embedding FROM v a, v b
                WHERE a.ordinal = 0 AND b.ordinal = (SELECT max(ordinal) FROM v)) AS between`,
      [bucket, key],
    );
    expect(rows[0]!.self).toBeCloseTo(0, 6);
    expect(rows[0]!.between).toBeGreaterThan(0.01);
  });

  it("is idempotent: replaying the same object changes no row counts (COMPASS-12)", async () => {
    const key = `docs/${randomUUID()}.md`;
    await put(key, multiPage);

    const [first] = await run(key);
    const before = await counts(key);
    const [second] = await run(key);

    expect(first!.outcome).toBe("embedded");
    expect(second!.outcome).toBe("unchanged");
    expect(await counts(key)).toEqual(before);
  });

  it("an overwrite with shorter content leaves no stale tail chunks", async () => {
    const key = `docs/${randomUUID()}.md`;
    await put(key, multiPage);
    await run(key);
    await put(key, "Now it is just one short paragraph.");
    await run(key);

    expect(await counts(key)).toEqual({ documents: 1, chunks: 1, embeddings: 1 });
  });

  it("the same bytes uploaded twice by one owner are embedded once (COMPASS-12)", async () => {
    const owner = `sub-${randomUUID()}`;
    const first = `uploads/${owner}/${randomUUID()}/notes.md`;
    const second = `uploads/${owner}/${randomUUID()}/notes.md`;
    await put(first, multiPage);
    await put(second, multiPage);

    await run(first);
    const [result] = await run(second);

    expect(result!.outcome).toBe("duplicate");
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.owner_sub = $1`,
      [owner],
    );
    expect(rows[0]!.n).toBe((await counts(first)).chunks);
  });

  it("records ownership and file name from an API-issued key", async () => {
    const key = `uploads/sub-abc/${randomUUID()}/Runbook.md`;
    await put(key, "Restart the pod with kubectl rollout restart.");
    await run(key);

    const { rows } = await pool.query(
      "SELECT owner_sub, file_name FROM documents WHERE bucket = $1 AND object_key = $2",
      [bucket, key],
    );
    expect(rows[0]).toEqual({ owner_sub: "sub-abc", file_name: "Runbook.md" });
  });

  it.each([
    ["empty", "docs/empty.txt", ""],
    ["undecodable", "docs/binary.txt", new Uint8Array([0xff, 0xfe, 0x00, 0x81])],
    ["unsupported", "docs/report.pdf", "%PDF-1.7"],
  ])("marks an %s object failed with a reason and no chunks", async (_label, base, body) => {
    const key = `${randomUUID()}-${base}`;
    await put(key, body);
    const [result] = await run(key);

    expect(result!.outcome).toBe("failed");
    const { rows } = await pool.query(
      "SELECT status, failure_reason FROM documents WHERE bucket = $1 AND object_key = $2",
      [bucket, key],
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failure_reason).toBeTruthy();
    expect((await counts(key)).chunks).toBe(0);
  });

  it("an embedding failure marks the document failed, leaves nothing searchable, and rethrows", async () => {
    const key = `docs/${randomUUID()}.md`;
    await put(key, multiPage);
    const broken: EmbeddingProvider = {
      dimensions: 1024,
      model: "broken",
      embed: () => Promise.reject(new Error("ThrottlingException")),
    };

    await expect(
      ingestObject({ pool, embedder: broken, fetchObject: getObject }, bucket, key),
    ).rejects.toThrowError(/Throttling/);

    const { rows } = await pool.query(
      "SELECT status, failure_reason FROM documents WHERE bucket = $1 AND object_key = $2",
      [bucket, key],
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0].failure_reason).toMatch(/Throttling/);
    expect((await counts(key)).chunks).toBe(0);
  });
});
