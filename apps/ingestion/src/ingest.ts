import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "@compass/llm";
import type { Pool } from "@compass/pg";
import { chunkText } from "./chunker.js";
import { decodeDocument } from "./decode.js";
import { beginDocument, markFailed, storeChunks } from "./document-store.js";
import { logger } from "./logger.js";
import { fileNameOf, parseUploadKey } from "./object-key.js";
import { MAX_OBJECT_BYTES, type FetchedObject } from "./s3-objects.js";

// The whole simplified pipeline (COMPASS-11, descoped 29 Aug: one function, no
// queue). Dependencies are injected so the unit tier can run it with a fake
// fetcher and a fake embedder; the integration tier runs it against real
// LocalStack S3 and real pgvector.

export interface IngestDeps {
  pool: Pool;
  embedder: EmbeddingProvider;
  fetchObject: (bucket: string, key: string) => Promise<FetchedObject>;
}

export type IngestOutcome = "embedded" | "unchanged" | "duplicate" | "failed";

export interface IngestResult {
  outcome: IngestOutcome;
  documentId: string;
  chunks?: number;
  reason?: string;
}

export async function ingestObject(
  deps: IngestDeps,
  bucket: string,
  key: string,
): Promise<IngestResult> {
  const fetched = await deps.fetchObject(bucket, key);
  const upload = parseUploadKey(key);
  const identity = {
    bucket,
    key,
    versionId: fetched.versionId,
    ownerSub: upload?.ownerSub ?? null,
    fileName: upload?.fileName ?? fileNameOf(key),
  };

  const bytes = fetched.kind === "ok" ? fetched.bytes : new Uint8Array(0);
  const byteSize = fetched.kind === "ok" ? bytes.byteLength : fetched.byteSize;
  // The hash of a too-large object is of nothing; key it on size instead so a
  // replay of the same rejected object is still recognised as the same.
  const contentHash =
    fetched.kind === "ok"
      ? createHash("sha256").update(bytes).digest("hex")
      : `too-large:${fetched.byteSize}`;

  const begun = await beginDocument(
    deps.pool,
    identity,
    contentHash,
    byteSize,
    deps.embedder.model,
  );
  const log = { bucket, key, documentId: begun.documentId };

  if (begun.outcome === "unchanged") {
    logger.info("ingest skipped: already embedded", log);
    return { outcome: "unchanged", documentId: begun.documentId };
  }
  if (begun.outcome === "duplicate") {
    logger.info("ingest skipped: duplicate content", { ...log, duplicateOf: begun.duplicateOf });
    return { outcome: "duplicate", documentId: begun.documentId };
  }

  const fail = async (reason: string): Promise<IngestResult> => {
    await markFailed(deps.pool, begun.documentId, reason);
    logger.warn("ingest failed", { ...log, reason });
    return { outcome: "failed", documentId: begun.documentId, reason };
  };

  if (fetched.kind === "too-large") {
    return fail(`object is ${fetched.byteSize} bytes; the limit is ${MAX_OBJECT_BYTES}`);
  }

  const decoded = decodeDocument(key, bytes);
  if (!decoded.ok) return fail(decoded.reason);

  const chunks = chunkText(decoded.text);
  if (chunks.length === 0) return fail("no extractable text");

  let embedded;
  try {
    embedded = await deps.embedder.embed(chunks.map((chunk) => chunk.content));
  } catch (error) {
    // Recorded AND rethrown. Recorded so the UI shows why; rethrown because an
    // embedding failure is usually transient (throttling, a cold endpoint), and
    // the Step Functions retry policy can only retry what it sees fail.
    await markFailed(deps.pool, begun.documentId, `embedding failed: ${(error as Error).message}`);
    throw error;
  }

  await storeChunks(deps.pool, begun.documentId, chunks, embedded.model, embedded.vectors);
  logger.info("ingest embedded", { ...log, chunks: chunks.length, model: embedded.model });
  return { outcome: "embedded", documentId: begun.documentId, chunks: chunks.length };
}
