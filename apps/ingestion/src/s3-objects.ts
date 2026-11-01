import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { baseClientConfig, isLocalstack } from "./aws-config.js";

// forcePathStyle is only safe to force when we're actually targeting
// LocalStack -- real S3 has deprecated path-style for anything but legacy
// us-east-1 buckets, so leave it to the SDK default otherwise.
const client = new S3Client({
  ...baseClientConfig,
  ...(isLocalstack ? { forcePathStyle: true } : {}),
});

export type FetchedObject =
  | {
      kind: "ok";
      bytes: Uint8Array;
      /** Empty string for an unversioned bucket -- matches documents.version_id. */
      versionId: string;
    }
  | { kind: "too-large"; byteSize: number; versionId: string };

// Hard cap before reading the body. Not a chunker concern: a 2 GB upload would
// exhaust the Lambda's memory in transformToByteArray long before any code
// could reject it. The presigned PUT enforces the same limit at upload time
// (apps/api), so this is the second belt.
export const MAX_OBJECT_BYTES = 5 * 1024 * 1024;

export async function getObject(bucket: string, key: string): Promise<FetchedObject> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`empty body for s3://${bucket}/${key}`);
  const versionId = response.VersionId ?? "";
  const byteSize = response.ContentLength ?? 0;
  if (byteSize > MAX_OBJECT_BYTES) {
    // Read nothing: release the socket instead of draining 2 GB through it.
    await response.Body.transformToWebStream()
      .cancel()
      .catch(() => undefined);
    return { kind: "too-large", byteSize, versionId };
  }
  return { kind: "ok", bytes: await response.Body.transformToByteArray(), versionId };
}
