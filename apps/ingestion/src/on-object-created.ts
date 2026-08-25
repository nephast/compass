import type { S3Handler } from "aws-lambda";
import { getObjectText } from "./s3-objects.js";
import { storeObjectAsChunk } from "./chunk-store.js";
import { parseS3Records } from "./s3-events.js";
import { logger } from "./logger.js";

// TODO (COMPASS-11): replace with real chunking + embeddings. For now this
// proves S3 -> Lambda -> pgvector end-to-end with a placeholder embedding.
export const handler: S3Handler = async (event) => {
  for (const { bucket, key } of parseS3Records(event)) {
    logger.info("object created", { bucket, key });

    const content = await getObjectText(bucket, key);
    await storeObjectAsChunk(bucket, key, content);

    logger.info("chunk stored", { bucket, key, bytes: content.length });
  }
};
