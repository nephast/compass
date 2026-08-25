// Pure event parsing — no AWS calls, no I/O. Split out from the handler so
// the fiddly bits (S3 URL-encodes object keys, and encodes spaces as "+")
// are unit-testable without Docker or LocalStack.
import type { S3Event } from "aws-lambda";

export interface ObjectRef {
  bucket: string;
  key: string;
}

export function parseS3Records(event: S3Event): ObjectRef[] {
  return event.Records.map((record) => ({
    bucket: record.s3.bucket.name,
    key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
  }));
}
