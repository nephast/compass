-- Up Migration

-- pgvector is installed by the master user during database bootstrap
-- (docs/runbooks/database-bootstrap.md), because CREATE EXTENSION needs
-- rds_superuser and the migration role deliberately does not have it. The guard
-- means this file still works against a fresh local container, where the
-- migration role is the superuser and no bootstrap has run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE EXTENSION vector;
  END IF;
END
$$;

-- One row per version of one S3 object. This is the unit of re-ingestion:
-- COMPASS-12 idempotency is "have we already processed this exact bytes", which
-- is why content_hash is here and not derived at query time.
CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket        TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  -- Empty string, not NULL, when the bucket is unversioned: NULL would make the
  -- unique constraint below stop constraining, since NULL != NULL in Postgres.
  version_id    TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  content_type  TEXT,
  byte_size     BIGINT,
  status        TEXT NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_status_check
    CHECK (status IN ('pending', 'chunked', 'embedded', 'failed')),
  CONSTRAINT documents_object_version_key UNIQUE (bucket, object_key, version_id)
);

-- Chunk text lives separately from its embedding so that re-chunking and
-- re-embedding are independent operations.
CREATE TABLE chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Doubles as the lookup index for "all chunks of this document", so no
  -- separate index on document_id is needed.
  CONSTRAINT chunks_document_ordinal_key UNIQUE (document_id, ordinal)
);

-- Separate from chunks because a pgvector column has a FIXED dimension, and
-- ARCHITECTURE.md commits to swapping LlmProvider by configuration. Titan Text
-- Embeddings V2 is 1024; OpenAI text-embedding-3-small is 1536. Keying on
-- (chunk_id, model) lets a re-embed run to completion alongside the old vectors
-- instead of requiring a table rewrite. See ADR-0005.
CREATE TABLE embeddings (
  chunk_id   UUID NOT NULL REFERENCES chunks (id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model)
);

-- HNSW rather than IVFFlat: IVFFlat's `lists` is tuned to row count, so building
-- it here -- on an empty table -- bakes in a permanently wrong value. HNSW needs
-- no training data. Cosine ops because the retrieval query orders by `<=>`.
-- Note the index does not cover `model`, so a query filtering on it post-filters
-- the ANN results; acceptable while one model is in use, revisit at two.
CREATE INDEX embeddings_embedding_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops);

CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Migrations run as compass_migrator, so these tables are owned by it and the
-- ALTER DEFAULT PRIVILEGES set for the master user in the bootstrap runbook does
-- not reach them. Granting here keeps the runtime role's access in the same
-- reviewed artefact as the schema itself. Guarded because compass_app does not
-- exist on a local container.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks, embeddings TO compass_app;
  END IF;
END
$$;

-- Down Migration

DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS documents;
