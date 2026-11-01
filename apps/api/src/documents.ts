import type { Pool } from "@compass/pg";

export interface DocumentSummary {
  id: string;
  fileName: string;
  status: string;
  failureReason: string | null;
  duplicateOf: string | null;
  chunks: number;
  byteSize: number | null;
  createdAt: string;
}

// Owner-scoped by construction: there is no code path here that takes a
// document id without also taking the caller's sub.
export async function listDocuments(pool: Pool, ownerSub: string): Promise<DocumentSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    file_name: string | null;
    status: string;
    failure_reason: string | null;
    duplicate_of: string | null;
    chunks: number;
    byte_size: string | null;
    created_at: Date;
  }>(
    `SELECT d.id, d.file_name, d.status, d.failure_reason, d.duplicate_of, d.byte_size,
            d.created_at, (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d
      WHERE d.owner_sub = $1
      ORDER BY d.created_at DESC
      LIMIT 100`,
    [ownerSub],
  );
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name ?? "untitled",
    status: row.status,
    failureReason: row.failure_reason,
    duplicateOf: row.duplicate_of,
    chunks: row.chunks,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    createdAt: row.created_at.toISOString(),
  }));
}
