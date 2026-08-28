import { createHash } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

// Lazily created, reused across invocations in the same execution
// environment -- same container-reuse pattern as the SDK clients.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Fixed by the migration: embeddings.embedding is VECTOR(1024), sized for
// Titan Text Embeddings V2 (ADR-0005). Changing it is a migration, not a
// constant edit.
const EMBEDDING_DIMENSIONS = 1024;

// TODO (COMPASS-19): replace with a real LlmProvider embeddings call. A fixed
// zero vector proves the pgvector round trip, nothing about semantic search --
// hence the model name, which keeps placeholder rows distinguishable from real
// ones once a second model exists.
const PLACEHOLDER_MODEL = "placeholder-zero";

function placeholderEmbedding(): string {
  return `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(",")}]`;
}

// TODO (COMPASS-11): this stores the whole object as one chunk at ordinal 0 --
// replace with real chunking once that lambda exists.
//
// Idempotency (COMPASS-12) comes from the schema, not from application logic:
// documents is unique on (bucket, object_key, version_id) and chunks on
// (document_id, ordinal), so a replayed object updates in place instead of
// duplicating. The whole thing is one transaction so a failure between the
// chunk and its embedding cannot leave a chunk that nothing can retrieve.
export async function storeObjectAsChunk(
  bucket: string,
  key: string,
  content: string,
): Promise<void> {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: documentRows } = await client.query<{ id: string }>(
      `INSERT INTO documents (bucket, object_key, content_hash, byte_size, status)
       VALUES ($1, $2, $3, $4, 'chunked')
       ON CONFLICT (bucket, object_key, version_id)
         DO UPDATE SET content_hash = EXCLUDED.content_hash,
                       byte_size    = EXCLUDED.byte_size,
                       status       = 'chunked'
       RETURNING id`,
      [bucket, key, contentHash, Buffer.byteLength(content)],
    );
    // DO UPDATE rather than DO NOTHING specifically so RETURNING yields a row
    // on the replay path -- DO NOTHING returns nothing and this would break.
    const documentId = documentRows[0]?.id;
    if (!documentId) throw new Error(`upsert of document ${bucket}/${key} returned no id`);

    const { rows: chunkRows } = await client.query<{ id: string }>(
      `INSERT INTO chunks (document_id, ordinal, content)
       VALUES ($1, 0, $2)
       ON CONFLICT (document_id, ordinal)
         DO UPDATE SET content = EXCLUDED.content
       RETURNING id`,
      [documentId, content],
    );
    const chunkId = chunkRows[0]?.id;
    if (!chunkId) throw new Error(`upsert of chunk 0 for document ${documentId} returned no id`);

    await client.query(
      `INSERT INTO embeddings (chunk_id, model, embedding)
       VALUES ($1, $2, $3::vector)
       ON CONFLICT (chunk_id, model)
         DO UPDATE SET embedding = EXCLUDED.embedding`,
      [chunkId, PLACEHOLDER_MODEL, placeholderEmbedding()],
    );

    await client.query("UPDATE documents SET status = 'embedded' WHERE id = $1", [documentId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
