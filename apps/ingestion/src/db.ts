import pg from "pg";

const { Pool } = pg;

// Lazily created, reused across invocations in the same execution
// environment -- same container-reuse pattern as the SDK clients.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Arbitrary and small -- this is a placeholder, not a real embedding
// dimension (Titan Embeddings is 1536). Picked only so the pgvector column
// type is well-formed.
const PLACEHOLDER_EMBEDDING_DIMENSIONS = 8;

let schemaReady = false;

// TODO (COMPASS-14): stand-in for a real migration. Replace once a
// migration tool is picked; this only exists so the scaffold has somewhere
// to write to.
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id BIGSERIAL PRIMARY KEY,
      bucket TEXT NOT NULL,
      object_key TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(${PLACEHOLDER_EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (bucket, object_key)
    )
  `);
  schemaReady = true;
}

// TODO (COMPASS-19): replace with a real LlmProvider embeddings call. A
// fixed zero vector proves the pgvector round trip, nothing about semantic
// search.
function placeholderEmbedding(): string {
  return `[${new Array(PLACEHOLDER_EMBEDDING_DIMENSIONS).fill(0).join(",")}]`;
}

// TODO (COMPASS-11): this stores the whole object as one "chunk" -- replace
// with real chunking once that lambda exists.
// ON CONFLICT keeps re-processing the same object idempotent (COMPASS-12
// also covers replayed SQS messages, not applicable to this direct-invoke
// scaffold).
export async function storeObjectAsChunk(bucket: string, key: string, content: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO chunks (bucket, object_key, content, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (bucket, object_key) DO NOTHING`,
    [bucket, key, content, placeholderEmbedding()],
  );
}
