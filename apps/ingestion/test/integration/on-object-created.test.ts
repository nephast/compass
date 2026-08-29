// Fast tier: the real handler, in this process, against real LocalStack S3
// and real Postgres/pgvector -- but no Lambda deploy. This is the loop you
// run on every save (~1s). The deploy path is proved separately in
// test/wiring, which is slow and doesn't need to run nearly as often.
//
// Requires: docker compose up -d --wait
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { handler } from "../../src/on-object-created.js";
import { createBucket, deleteBucket, s3 } from "../helpers/localstack.js";
import { s3Event } from "../helpers/s3-event-fixture.js";

const bucket = `compass-ingestion-test-${randomUUID()}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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

async function put(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

describe("ingestion handler", () => {
  it("stores the object body as a chunk row with an embedding", async () => {
    const key = `docs/${randomUUID()}.txt`;
    await put(key, "hello");

    await handler(s3Event(bucket, key), {} as never, () => {});

    const { rows } = await pool.query(
      `SELECT c.content, c.ordinal, d.status, d.content_hash, e.embedding
         FROM documents d
         JOIN chunks c ON c.document_id = d.id
         JOIN embeddings e ON e.chunk_id = c.id
        WHERE d.bucket = $1 AND d.object_key = $2`,
      [bucket, key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("hello");
    expect(rows[0].ordinal).toBe(0);
    expect(rows[0].status).toBe("embedded");
    // Placeholder embedding (COMPASS-19) -- assert the pgvector round trip
    // produced a well-formed vector of the migrated dimension, not that it
    // means anything.
    expect(JSON.parse(rows[0].embedding)).toHaveLength(1024);
  });

  it("is idempotent — reprocessing the same object doesn't duplicate rows", async () => {
    // COMPASS-12 proper covers replayed SQS messages; this is the
    // same-object-twice half of it, which the UNIQUE constraint already gives us.
    const key = `docs/${randomUUID()}.txt`;
    await put(key, "once");

    await handler(s3Event(bucket, key), {} as never, () => {});
    await handler(s3Event(bucket, key), {} as never, () => {});

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM documents d JOIN chunks c ON c.document_id = d.id
        WHERE d.bucket = $1 AND d.object_key = $2`,
      [bucket, key],
    );
    expect(rows[0].n).toBe(1);
  });
});
