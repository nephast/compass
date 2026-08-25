import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { baseClientConfig, isLocalstack } from "./aws-config.js";

// forcePathStyle is only safe to force when we're actually targeting
// LocalStack -- real S3 has deprecated path-style for anything but legacy
// us-east-1 buckets, so leave it to the SDK default otherwise.
const client = new S3Client({
  ...baseClientConfig,
  ...(isLocalstack ? { forcePathStyle: true } : {}),
});

export async function getObjectText(bucket: string, key: string): Promise<string> {
  const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body) throw new Error(`empty body for s3://${bucket}/${key}`);
  return Body.transformToString();
}
