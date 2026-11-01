// Creates the local dev bucket in LocalStack. Idempotent -- safe to run on
// every `npm run local:up`. Plain .mjs so it needs no build step.
//
// Only S3 lives here: the schema is owned by apps/db's migrations, which
// `npm run local:up` runs first.
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

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

// The browser PUTs straight to the bucket with a presigned URL (COMPASS-9), so
// the local bucket needs the same CORS rule CDK puts on the real one.
await s3.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedMethods: ["PUT"],
          AllowedOrigins: ["http://localhost:3000"],
          AllowedHeaders: ["content-type", "content-length"],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  }),
);
console.log(`cors set on ${bucket} for http://localhost:3000`);
