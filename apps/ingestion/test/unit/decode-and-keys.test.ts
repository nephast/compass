import { describe, expect, it } from "vitest";
import { decodeDocument } from "../../src/decode.js";
import { fileNameOf, parseUploadKey } from "../../src/object-key.js";
import { parseIngestEvent } from "../../src/s3-events.js";
import { s3Event } from "../helpers/s3-event-fixture.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeDocument", () => {
  it("accepts UTF-8 text and markdown", () => {
    expect(decodeDocument("a/notes.md", utf8("# hi"))).toEqual({ ok: true, text: "# hi" });
    expect(decodeDocument("a/NOTES.TXT", utf8("hi"))).toEqual({ ok: true, text: "hi" });
  });

  it("records unsupported types as a reason, not an exception", () => {
    const result = decodeDocument("a/report.pdf", utf8("%PDF-1.7"));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/\.pdf/);
  });

  it("rejects empty, non-UTF-8 and binary bodies", () => {
    expect(decodeDocument("a.txt", new Uint8Array(0))).toMatchObject({
      ok: false,
      reason: "empty object",
    });
    expect(decodeDocument("a.txt", new Uint8Array([0xff, 0xfe, 0xfd]))).toMatchObject({
      ok: false,
      reason: "not valid UTF-8 text",
    });
    expect(decodeDocument("a.txt", utf8("abc\u0000def"))).toMatchObject({ ok: false });
  });
});

describe("parseUploadKey", () => {
  it("recovers the owner and file name from an API-issued key", () => {
    expect(parseUploadKey("uploads/sub-123/7f0c/My Notes.md")).toEqual({
      ownerSub: "sub-123",
      fileName: "My Notes.md",
    });
  });

  it("returns null for keys the API did not issue", () => {
    expect(parseUploadKey("docs/a.txt")).toBeNull();
    expect(parseUploadKey("uploads/sub-123/a.txt")).toBeNull();
    expect(parseUploadKey("uploads/sub/x/y/z.txt")).toBeNull();
  });

  it("falls back to the last path segment for display", () => {
    expect(fileNameOf("docs/deep/a.txt")).toBe("a.txt");
  });
});

describe("parseIngestEvent", () => {
  it("accepts an S3 notification, decoding its key", () => {
    expect(parseIngestEvent(s3Event("b", "my+notes.md"))).toEqual([
      { bucket: "b", key: "my notes.md" },
    ]);
  });

  it("accepts EventBridge Object Created detail WITHOUT decoding its key", () => {
    // EventBridge keys are not URL-encoded: a literal '+' must survive.
    expect(parseIngestEvent({ bucket: { name: "b" }, object: { key: "c++.md" } })).toEqual([
      { bucket: "b", key: "c++.md" },
    ]);
  });

  it("rejects anything else loudly", () => {
    expect(() => parseIngestEvent({ hello: "world" })).toThrowError(/unrecognised/);
  });
});
