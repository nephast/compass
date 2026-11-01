import { embeddingProviderFromEnv } from "@compass/llm";
import { createPool } from "@compass/pg";
import { ingestObject, type IngestResult } from "./ingest.js";
import { logger } from "./logger.js";
import { getObject } from "./s3-objects.js";
import { parseIngestEvent } from "./s3-events.js";

// Created once per execution environment and reused across invocations --
// the same container-reuse pattern as the S3 client. max: 2 because one
// invocation handles one document at a time; the pool exists for reconnects.
const deps = {
  pool: createPool(process.env, { max: 2 }),
  embedder: embeddingProviderFromEnv(),
  fetchObject: getObject,
};

export const handler = async (event: unknown): Promise<IngestResult[]> => {
  const results: IngestResult[] = [];
  for (const { bucket, key } of parseIngestEvent(event)) {
    logger.info("object created", { bucket, key });
    results.push(await ingestObject(deps, bucket, key));
  }
  // Returned so the Step Functions execution history shows the outcome per
  // document -- "duplicate" and "failed" are both successful executions, and
  // without this the console would show them identically.
  return results;
};
