-- Up Migration

-- Ownership, so retrieval can be scoped to the caller. Authentication (the
-- Cognito JWT checked at API Gateway) says WHO is asking; without this column
-- nothing says WHAT they may read, and every user's query would search every
-- user's documents.
--
-- Derived by the ingestion handler from the object key, which the api service
-- builds as uploads/<cognito sub>/<uuid>/<filename> when it presigns the PUT.
-- The client never chooses the prefix, so it cannot upload into someone else's.
--
-- Nullable, not NOT NULL: rows ingested before this migration, and objects put
-- into the bucket by hand (the bootstrap and wiring tests do this), have no
-- owner. They are unreachable from the API rather than visible to everyone.
ALTER TABLE documents ADD COLUMN owner_sub TEXT;

-- Retrieval filters on owner first, then orders by vector distance.
CREATE INDEX documents_owner_sub_idx ON documents (owner_sub);

-- Display name for the UI, so it does not have to reverse-engineer the key.
ALTER TABLE documents ADD COLUMN file_name TEXT;

-- Content-addressed dedupe within one owner (COMPASS-12). Uploading the same
-- bytes twice through the API produces two object keys -- the key carries a
-- fresh UUID -- so the (bucket, object_key, version_id) constraint alone cannot
-- see that they are the same document. The second one is recorded, pointing at
-- the first, and never chunked or embedded: no duplicate vectors, no second
-- embedding bill, and the user still sees their upload acknowledged.
ALTER TABLE documents ADD COLUMN duplicate_of UUID REFERENCES documents (id) ON DELETE SET NULL;
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('pending', 'chunked', 'embedded', 'failed', 'duplicate'));
CREATE INDEX documents_owner_hash_idx ON documents (owner_sub, content_hash);

-- Down Migration

DROP INDEX IF EXISTS documents_owner_hash_idx;
DELETE FROM documents WHERE status = 'duplicate';
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('pending', 'chunked', 'embedded', 'failed'));
ALTER TABLE documents DROP COLUMN IF EXISTS duplicate_of;

DROP INDEX IF EXISTS documents_owner_sub_idx;
ALTER TABLE documents DROP COLUMN IF EXISTS file_name;
ALTER TABLE documents DROP COLUMN IF EXISTS owner_sub;
