// The api service presigns PUTs only under uploads/<cognito sub>/<uuid>/<name>
// (apps/api/src/uploads.ts). Parsing it back here is how ownership crosses
// the asynchronous boundary without a second message channel: the key IS the
// message. Pure, so the encoding rules are unit-tested without S3.

export interface UploadKey {
  ownerSub: string;
  fileName: string;
}

const UPLOAD_KEY = /^uploads\/([^/]+)\/[^/]+\/([^/]+)$/;

export function parseUploadKey(key: string): UploadKey | null {
  const match = UPLOAD_KEY.exec(key);
  if (!match) return null;
  return { ownerSub: match[1] as string, fileName: match[2] as string };
}

export function fileNameOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}
