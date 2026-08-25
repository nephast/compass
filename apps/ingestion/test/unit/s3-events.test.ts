import { describe, expect, it } from "vitest";
import { parseS3Records } from "../../src/s3-events.js";
import { s3Event } from "../helpers/s3-event-fixture.js";

// No Docker, no LocalStack -- this tier runs in CI and on every save.
describe("parseS3Records", () => {
  it("reads bucket and key from an ObjectCreated event", () => {
    expect(parseS3Records(s3Event("docs", "a/b.txt"))).toEqual([
      { bucket: "docs", key: "a/b.txt" },
    ]);
  });

  it("decodes '+' back to a space", () => {
    // S3 encodes spaces in object keys as '+', so a naive handler stores the
    // wrong key and every later lookup misses.
    expect(parseS3Records(s3Event("docs", "my+report.txt"))[0]!.key).toBe("my report.txt");
  });

  it("percent-decodes the key", () => {
    expect(parseS3Records(s3Event("docs", "caf%C3%A9.txt"))[0]!.key).toBe("café.txt");
  });

  it("handles a multi-record event", () => {
    const event = s3Event("docs", "one.txt");
    event.Records.push(...s3Event("docs", "two.txt").Records);
    expect(parseS3Records(event).map((r) => r.key)).toEqual(["one.txt", "two.txt"]);
  });
});
