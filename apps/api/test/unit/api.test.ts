import { FakeCompletionProvider, FakeEmbeddingProvider } from "@compass/llm";
import type { Pool } from "@compass/pg";
import { describe, expect, it } from "vitest";
import { Unauthorized, createAuthenticator } from "../../src/auth.js";
import { loadConfig, type ApiConfig } from "../../src/config.js";
import { buildPrompt, citedNumbers } from "../../src/rag.js";
import { buildServer } from "../../src/server.js";
import {
  buildUploadKey,
  createS3Client,
  sanitiseFileName,
  validateUpload,
} from "../../src/uploads.js";

const config: ApiConfig = {
  port: 0,
  documentsBucket: "docs",
  authMode: "dev",
  cognito: null,
  rag: { topK: 5, maxDistance: 0.75 },
  uploadMaxBytes: 1000,
};

function app(overrides: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer({
    config,
    pool: {} as Pool,
    s3: createS3Client("http://localhost:4566"),
    embedder: new FakeEmbeddingProvider(),
    completer: new FakeCompletionProvider(),
    authenticate: createAuthenticator(config),
    ...overrides,
  });
}

describe("uploads", () => {
  it("builds keys under the caller's prefix, never the client's", () => {
    expect(buildUploadKey("abc-123", "../../etc/passwd.md", "id")).toBe(
      "uploads/abc-123/id/passwd.md",
    );
    expect(() => buildUploadKey("../other", "a.md")).toThrowError(/subject/);
  });

  it("sanitises names and rejects what it cannot clean", () => {
    expect(sanitiseFileName("My <Notes>.md")).toBe("My _Notes_.md");
    expect(() => sanitiseFileName("...")).toThrowError();
  });

  it("allows only text/markdown within the size limit", () => {
    expect(() => validateUpload("a.pdf", 10, 1000)).toThrowError(/\.txt and \.md/);
    expect(() => validateUpload("a.md", 1001, 1000)).toThrowError(/larger/);
    expect(() => validateUpload("a.md", 0, 1000)).toThrowError(/positive/);
    expect(() => validateUpload("a.md", 10, 1000)).not.toThrow();
  });
});

describe("config", () => {
  it("refuses dev auth outside LocalStack", () => {
    expect(() => loadConfig({ DOCUMENTS_BUCKET: "b", AUTH_MODE: "dev" })).toThrowError(
      /LocalStack/,
    );
  });

  it("requires Cognito settings in cognito mode", () => {
    expect(() => loadConfig({ DOCUMENTS_BUCKET: "b" })).toThrowError(/COGNITO_USER_POOL_ID/);
  });
});

describe("cognito authenticator", () => {
  const authenticate = createAuthenticator({
    ...config,
    authMode: "cognito",
    cognito: { userPoolId: "eu-west-1_abcdefghi", clientIds: ["client"] },
  });

  it("rejects a missing or garbage bearer token as 401", async () => {
    await expect(authenticate({})).rejects.toBeInstanceOf(Unauthorized);
    await expect(authenticate({ authorization: "Bearer not-a-jwt" })).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });
});

describe("rag prompt", () => {
  it("numbers passages and extracts only cited numbers", () => {
    const prompt = buildPrompt("q?", [
      { n: 1, documentId: "d", fileName: "a.md", ordinals: [0], text: "alpha", distance: 0.1 },
    ]);
    expect(prompt).toContain('[1] (from "a.md")\nalpha');
    expect(citedNumbers("See [1] and [3][1].")).toEqual([1, 3]);
  });
});

describe("http surface", () => {
  it("serves /healthz without auth", async () => {
    const response = await app().inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 401 with a trace id when unauthenticated", async () => {
    const response = await app().inject({ method: "GET", url: "/documents" });
    expect(response.statusCode).toBe(401);
    expect(response.json().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("continues an incoming traceparent", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/query",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      payload: { question: "x" },
    });
    expect(response.json().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("validates bodies before any handler runs", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/documents/upload-url",
      headers: { "x-dev-user": "u1" },
      payload: { fileName: "a.md", size: "big", extra: 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("presigns a PUT under the caller's prefix with the size signed in", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/documents/upload-url",
      headers: { "x-dev-user": "user-1" },
      payload: { fileName: "Runbook.md", size: 120 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.key).toMatch(/^uploads\/user-1\/[0-9a-f-]{36}\/Runbook\.md$/);
    expect(body.url).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
    // No checksum of the (empty) body at signing time -- S3 would reject the
    // real upload against it. See createS3Client.
    expect(body.url).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);
  });
});
