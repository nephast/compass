import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginSignIn, codeChallenge, completeSignIn } from "../lib/pkce";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const endpoints = {
  authDomain: "auth.example.com",
  clientId: "client",
  redirectUri: "https://app.example.com/",
};

describe("PKCE", () => {
  it("computes the RFC 7636 S256 challenge", async () => {
    // RFC 7636 Appendix B test vector.
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const verifier = "another-verifier";
    expect(await codeChallenge(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("builds an authorize URL with S256 and a state", async () => {
    const storage = new MemoryStorage();
    const url = new URL(await beginSignIn(endpoints, storage));
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("refuses a callback whose state this tab did not issue (CSRF)", async () => {
    const storage = new MemoryStorage();
    await beginSignIn(endpoints, storage);
    await expect(
      completeSignIn(
        endpoints,
        new URLSearchParams({ code: "c", state: "forged" }),
        storage,
        async () => new Response("{}"),
      ),
    ).rejects.toThrowError(/did not match/);
  });

  it("exchanges the code with the verifier and stores tokens", async () => {
    const storage = new MemoryStorage();
    const url = new URL(await beginSignIn(endpoints, storage));
    let sent: URLSearchParams | null = null;
    const tokens = await completeSignIn(
      endpoints,
      new URLSearchParams({ code: "the-code", state: url.searchParams.get("state")! }),
      storage,
      async (_input, init) => {
        sent = new URLSearchParams(init?.body as string);
        return new Response(
          JSON.stringify({ access_token: "a", id_token: "i", refresh_token: "r", expires_in: 900 }),
        );
      },
    );
    expect(sent!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(await codeChallenge(sent!.get("code_verifier")!)).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(tokens.accessToken).toBe("a");
  });
});
