// Local stand-in for S3 -> EventBridge -> Step Functions: polls the LocalStack
// bucket and runs the REAL ingest function on every upload. Replays are
// harmless by design -- an already-embedded object comes back "unchanged" --
// which is exactly the COMPASS-12 property, exercised every 2 seconds.
//
//   npm run watch -w @compass/ingestion
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { embeddingProviderFromEnv } from "@compass/llm";
import { createPool } from "@compass/pg";
import { baseClientConfig } from "../src/aws-config.js";
import { ingestObject } from "../src/ingest.js";
import { getObject } from "../src/s3-objects.js";

const bucket = process.env.RAW_DOCUMENTS_BUCKET ?? "compass-raw-documents";
const s3 = new S3Client({ ...baseClientConfig, forcePathStyle: true });
const deps = { pool: createPool(), embedder: embeddingProviderFromEnv(), fetchObject: getObject };
const seen = new Map<string, string>();

console.warn(`watching s3://${bucket}/uploads/ (embedder: ${deps.embedder.model})`);
for (;;) {
  try {
    const { Contents = [] } = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "uploads/" }),
    );
    for (const object of Contents) {
      if (!object.Key || seen.get(object.Key) === object.ETag) continue;
      seen.set(object.Key, object.ETag ?? "");
      await ingestObject(deps, bucket, object.Key).catch((error: unknown) =>
        console.error("ingest failed", object.Key, error),
      );
    }
  } catch (error) {
    console.error("watch loop error", error);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
