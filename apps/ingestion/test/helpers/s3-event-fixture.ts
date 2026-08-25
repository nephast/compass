import type { S3Event } from "aws-lambda";

// Minimal S3 ObjectCreated event -- only the fields the handler actually
// reads. Cast rather than hand-writing the full ~30-field record shape.
export function s3Event(bucket: string, key: string): S3Event {
  return {
    Records: [{ s3: { bucket: { name: bucket }, object: { key } } }],
  } as S3Event;
}
