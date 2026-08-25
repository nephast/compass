import type { S3Handler } from "aws-lambda";
import { getObjectText } from "./s3.js";
import { storeObjectAsChunk } from "./db.js";

// TODO (COMPASS-11): replace with real chunking + embeddings. For now this
// proves S3 -> Lambda -> pgvector end-to-end with a placeholder embedding.
export const handler: S3Handler = async (event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    console.error(`[ingestion] object created: s3://${bucket}/${key}`);

    const content = await getObjectText(bucket, key);
    await storeObjectAsChunk(bucket, key, content);
  }
};
