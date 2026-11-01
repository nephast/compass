// Pure event parsing — no AWS calls, no I/O. Split out from the handler so
// the fiddly bits are unit-testable without Docker or LocalStack.
//
// Two shapes arrive here:
//   - an S3 notification (local dev: LocalStack invokes the function directly)
//   - the `detail` of an EventBridge "Object Created" event, passed through by
//     the Step Functions state machine (deployed path, COMPASS-10)
// S3 notifications URL-encode keys (and encode spaces as "+"); EventBridge
// events do not. Getting that backwards silently ingests "my+notes.md" as a
// key that does not exist.
import type { S3Event } from "aws-lambda";

export interface ObjectRef {
  bucket: string;
  key: string;
}

export interface EventBridgeObjectDetail {
  bucket: { name: string };
  object: { key: string };
}

export function parseS3Records(event: S3Event): ObjectRef[] {
  return event.Records.map((record) => ({
    bucket: record.s3.bucket.name,
    key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
  }));
}

export function parseIngestEvent(event: unknown): ObjectRef[] {
  if (typeof event === "object" && event !== null) {
    if ("Records" in event && Array.isArray((event as S3Event).Records)) {
      return parseS3Records(event as S3Event);
    }
    const detail = event as Partial<EventBridgeObjectDetail>;
    if (typeof detail.bucket?.name === "string" && typeof detail.object?.key === "string") {
      return [{ bucket: detail.bucket.name, key: detail.object.key }];
    }
  }
  throw new Error("unrecognised ingest event: expected an S3 notification or EventBridge detail");
}
