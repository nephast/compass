// Creates the local dev bucket in LocalStack. Idempotent -- safe to run on
// every `npm run local:up`. Plain .mjs so it needs no build step.
//
// Only S3 lives here: the chunks table is created on demand by src/db.ts
// (a COMPASS-14 stand-in), and keeping one owner of the schema beats having
// a bootstrap script and the app disagree about it.
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

if (process.env.NODE_ENV !== "production") {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    // No .env yet -- defaults below cover a stock docker compose stack.
  }
}

const endpoint = process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
const bucket = process.env.RAW_DOCUMENTS_BUCKET ?? "compass-raw-documents";

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "eu-west-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`bucket already exists: ${bucket}`);
} catch (err) {
  if (err?.$metadata?.httpStatusCode !== 404 && err.name !== "NotFound") throw err;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`created bucket: ${bucket}`);
}
