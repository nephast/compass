import type { Pool, PoolClient } from "@compass/pg";
import type { Chunk } from "./chunker.js";

// Every write the ingestion pipeline makes, and nothing else. Idempotency
// (COMPASS-12) lives in three places, each catching a different replay:
//
//   1. Same object, same bytes, already embedded -> "unchanged", no work, no
//      embedding spend. A replayed EventBridge event or a Step Functions retry
//      after a late failure lands here.
//   2. Same object, new bytes (an overwrite) -> chunks are upserted by
//      (document_id, ordinal) and any ordinal past the new count is deleted,
//      so a shorter rewrite cannot leave stale tail chunks behind.
//   3. Different object, same owner, same bytes -> recorded as a duplicate of
//      the first and never embedded. This is the "upload the same file twice"
//      case through the API, where each upload gets a fresh key.
//
// The schema's unique constraints make every insert below an upsert, so even
// two concurrent runs for one object converge on one set of rows.

export interface ObjectIdentity {
  bucket: string;
  key: string;
  versionId: string;
  ownerSub: string | null;
  fileName: string;
}

export type BeginResult =
  | { outcome: "process"; documentId: string }
  | { outcome: "unchanged"; documentId: string }
  | { outcome: "duplicate"; documentId: string; duplicateOf: string };

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function beginDocument(
  pool: Pool,
  object: ObjectIdentity,
  contentHash: string,
  byteSize: number,
  model: string,
): Promise<BeginResult> {
  return inTransaction(pool, async (client) => {
    // Row lock on the existing document (if any), so two concurrent deliveries
    // of the same event serialise here instead of both deciding to embed.
    const { rows: existing } = await client.query<{
      id: string;
      content_hash: string;
      status: string;
    }>(
      `SELECT id, content_hash, status FROM documents
        WHERE bucket = $1 AND object_key = $2 AND version_id = $3
        FOR UPDATE`,
      [object.bucket, object.key, object.versionId],
    );
    const current = existing[0];

    if (current && current.content_hash === contentHash && current.status === "embedded") {
      // Embedded with THIS model, specifically. After an embedding-model swap
      // (ADR-0006) the same bytes need a re-embed, and this check is what lets
      // a replay perform it rather than skip it.
      const { rows } = await client.query(
        `SELECT 1 FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
          WHERE c.document_id = $1 AND e.model = $2 LIMIT 1`,
        [current.id, model],
      );
      if (rows.length > 0) return { outcome: "unchanged", documentId: current.id };
    }

    if (object.ownerSub !== null) {
      const { rows: twins } = await client.query<{ id: string }>(
        `SELECT id FROM documents
          WHERE owner_sub = $1 AND content_hash = $2 AND status = 'embedded'
            AND NOT (bucket = $3 AND object_key = $4 AND version_id = $5)
          ORDER BY created_at
          LIMIT 1`,
        [object.ownerSub, contentHash, object.bucket, object.key, object.versionId],
      );
      const twin = twins[0];
      if (twin) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO documents
             (bucket, object_key, version_id, content_hash, byte_size, owner_sub, file_name,
              status, duplicate_of)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'duplicate', $8)
           ON CONFLICT (bucket, object_key, version_id) DO UPDATE
             SET content_hash = EXCLUDED.content_hash, byte_size = EXCLUDED.byte_size,
                 status = 'duplicate', duplicate_of = EXCLUDED.duplicate_of,
                 failure_reason = NULL
           RETURNING id`,
          [
            object.bucket,
            object.key,
            object.versionId,
            contentHash,
            byteSize,
            object.ownerSub,
            object.fileName,
            twin.id,
          ],
        );
        // A duplicate owns no chunks. If this key previously held different
        // bytes, its old chunks would otherwise stay searchable.
        await client.query("DELETE FROM chunks WHERE document_id = $1", [rows[0]?.id]);
        return { outcome: "duplicate", documentId: rows[0]?.id as string, duplicateOf: twin.id };
      }
    }

    // DO UPDATE rather than DO NOTHING specifically so RETURNING yields a row
    // on the replay path -- DO NOTHING returns nothing.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents
         (bucket, object_key, version_id, content_hash, byte_size, owner_sub, file_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT (bucket, object_key, version_id) DO UPDATE
         SET content_hash = EXCLUDED.content_hash, byte_size = EXCLUDED.byte_size,
             owner_sub = EXCLUDED.owner_sub, file_name = EXCLUDED.file_name,
             status = 'pending', failure_reason = NULL, duplicate_of = NULL
       RETURNING id`,
      [
        object.bucket,
        object.key,
        object.versionId,
        contentHash,
        byteSize,
        object.ownerSub,
        object.fileName,
      ],
    );
    const documentId = rows[0]?.id;
    if (!documentId)
      throw new Error(`upsert of document ${object.bucket}/${object.key} returned no id`);
    return { outcome: "process", documentId };
  });
}

/**
 * Records a failure and removes anything searchable for the document, in one
 * transaction: a failed document must never be half-visible to retrieval.
 */
export async function markFailed(pool: Pool, documentId: string, reason: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
    await client.query(
      "UPDATE documents SET status = 'failed', failure_reason = $2 WHERE id = $1",
      [documentId, reason.slice(0, 1000)],
    );
  });
}

/**
 * Writes chunks and their vectors in ONE transaction, after the slow embedding
 * calls have already finished outside it. Holding a transaction open across
 * network calls to Bedrock would pin a connection (of ~80 on a t3.micro) for
 * the whole document; this way the transaction lasts milliseconds.
 */
export async function storeChunks(
  pool: Pool,
  documentId: string,
  chunks: Chunk[],
  model: string,
  vectors: number[][],
): Promise<void> {
  if (chunks.length !== vectors.length) {
    throw new Error(`${chunks.length} chunks but ${vectors.length} vectors for ${documentId}`);
  }

  await inTransaction(pool, async (client) => {
    await client.query("DELETE FROM chunks WHERE document_id = $1 AND ordinal >= $2", [
      documentId,
      chunks.length,
    ]);

    for (const [index, chunk] of chunks.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO chunks (document_id, ordinal, content, token_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, ordinal)
           DO UPDATE SET content = EXCLUDED.content, token_count = EXCLUDED.token_count
         RETURNING id`,
        // ~4 characters per token for English: an estimate. It feeds prompt
        // budgeting in the RAG flow, never billing.
        [documentId, chunk.ordinal, chunk.content, Math.ceil(chunk.content.length / 4)],
      );
      const chunkId = rows[0]?.id;
      if (!chunkId) throw new Error(`upsert of chunk ${chunk.ordinal} returned no id`);

      await client.query(
        `INSERT INTO embeddings (chunk_id, model, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [chunkId, model, `[${(vectors[index] as number[]).join(",")}]`],
      );
    }

    await client.query(
      "UPDATE documents SET status = 'embedded', failure_reason = NULL WHERE id = $1",
      [documentId],
    );
  });
}
