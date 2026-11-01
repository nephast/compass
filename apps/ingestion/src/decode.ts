// Text and Markdown only (COMPASS-11 scope). Anything else is a *recorded*
// failure, not an exception: retrying a PDF will never make it a text file,
// so throwing would burn the retry budget and end in the same place.

const SUPPORTED_EXTENSIONS = new Set(["txt", "md", "markdown", "text"]);

export type DecodeResult = { ok: true; text: string } | { ok: false; reason: string };

export function decodeDocument(key: string, bytes: Uint8Array): DecodeResult {
  const dot = key.lastIndexOf(".");
  const extension = dot === -1 ? "" : key.slice(dot + 1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: `unsupported file type ".${extension}" — only .txt and .md are ingested`,
    };
  }

  if (bytes.byteLength === 0) return { ok: false, reason: "empty object" };

  let text: string;
  try {
    // fatal: true -- the default replaces invalid bytes with U+FFFD and carries
    // on, which would quietly embed mojibake from a binary renamed to .txt.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8 text" };
  }

  if (text.includes("\u0000")) return { ok: false, reason: "binary content (NUL bytes)" };
  return { ok: true, text };
}
