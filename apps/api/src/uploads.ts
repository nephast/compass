import { randomUUID } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The presigned PUT is the only way a document enters the system, and its key
// is built HERE, never by the client: uploads/<sub>/<uuid>/<name>. The sub
// comes from the verified token, so a caller cannot write into another user's
// prefix, and the ingestion Lambda reads ownership back from the key.

export const UPLOAD_URL_TTL_SECONDS = 300;
const ALLOWED_EXTENSIONS = new Set(["txt", "md", "markdown"]);

export class BadRequest extends Error {
  readonly statusCode = 400;
}

/** Strips any path, keeps a conservative character set, bounds the length. */
export function sanitiseFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned === "") throw new BadRequest("fileName is empty after sanitising");
  return cleaned.slice(-120);
}

export function buildUploadKey(sub: string, fileName: string, id: string = randomUUID()): string {
  if (!/^[A-Za-z0-9-]+$/.test(sub)) throw new BadRequest("unexpected subject format");
  return `uploads/${sub}/${id}/${sanitiseFileName(fileName)}`;
}

export function validateUpload(fileName: string, size: number, maxBytes: number): void {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (!fileName.includes(".") || !ALLOWED_EXTENSIONS.has(extension)) {
    throw new BadRequest("only .txt and .md files are accepted");
  }
  if (!Number.isInteger(size) || size <= 0) throw new BadRequest("size must be a positive integer");
  if (size > maxBytes) throw new BadRequest(`file is larger than ${maxBytes} bytes`);
}

export async function presignUpload(
  s3: S3Client,
  bucket: string,
  key: string,
  size: number,
  contentType: string,
): Promise<string> {
  // ContentLength and ContentType are part of the signature: S3 rejects a PUT
  // whose body length or type differs from what was declared here, so the size
  // limit cannot be bypassed by asking for a small URL and sending a big file.
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentLength: size,
      ContentType: contentType,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(["content-length", "content-type"]),
    },
  );
}
