// OAuth 2.0 authorization code + PKCE against Cognito's managed login,
// hand-rolled rather than Amplify (see the frontend README): ~100 lines of
// standard protocol instead of a large dependency, and every step is visible.
//
// Token storage is sessionStorage: it survives the redirect back from Cognito
// and a reload, but not a closed tab, and is not sent with any request the way
// a cookie would be. The trade-off against an httpOnly cookie is that script
// on this origin can read it -- which the CSP (script-src 'self') is there to
// prevent. Access tokens live 15 minutes (infra/cdk/lib/auth-stack.ts).

const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** S256 code challenge: base64url(sha256(verifier)). RFC 7636 §4.2. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface Tokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AuthEndpoints {
  authDomain: string;
  clientId: string;
  redirectUri: string;
}

const VERIFIER_KEY = "compass.pkce.verifier";
const STATE_KEY = "compass.pkce.state";
const TOKENS_KEY = "compass.tokens";

export async function beginSignIn(endpoints: AuthEndpoints, storage: Storage): Promise<string> {
  const verifier = randomString(48);
  const state = randomString(16);
  storage.setItem(VERIFIER_KEY, verifier);
  storage.setItem(STATE_KEY, state);
  const url = new URL(`https://${endpoints.authDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: endpoints.clientId,
    redirect_uri: endpoints.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function parseTokens(body: Record<string, unknown>, previousRefresh?: string): Tokens {
  const tokens: Tokens = {
    accessToken: String(body.access_token),
    idToken: String(body.id_token),
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
  };
  const refresh = (body.refresh_token as string | undefined) ?? previousRefresh;
  if (refresh) tokens.refreshToken = refresh;
  return tokens;
}

export async function completeSignIn(
  endpoints: AuthEndpoints,
  params: URLSearchParams,
  storage: Storage,
  fetchImpl: typeof fetch = fetch,
): Promise<Tokens> {
  const code = params.get("code");
  const state = params.get("state");
  const expected = storage.getItem(STATE_KEY);
  const verifier = storage.getItem(VERIFIER_KEY);
  storage.removeItem(STATE_KEY);
  storage.removeItem(VERIFIER_KEY);
  // The state check is the CSRF defence on the callback: a code delivered to
  // this page that this tab did not ask for is refused.
  if (!code || !state || !expected || state !== expected || !verifier) {
    throw new Error("sign-in response did not match a request from this tab");
  }

  const response = await fetchImpl(`https://${endpoints.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: endpoints.clientId,
      code,
      redirect_uri: endpoints.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: HTTP ${response.status}`);
  const tokens = parseTokens((await response.json()) as Record<string, unknown>);
  storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

export async function refresh(
  endpoints: AuthEndpoints,
  tokens: Tokens,
  storage: Storage,
  fetchImpl: typeof fetch = fetch,
): Promise<Tokens | null> {
  if (!tokens.refreshToken) return null;
  const response = await fetchImpl(`https://${endpoints.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: endpoints.clientId,
      refresh_token: tokens.refreshToken,
    }),
  });
  if (!response.ok) {
    storage.removeItem(TOKENS_KEY);
    return null;
  }
  const next = parseTokens((await response.json()) as Record<string, unknown>, tokens.refreshToken);
  storage.setItem(TOKENS_KEY, JSON.stringify(next));
  return next;
}

export function storedTokens(storage: Storage): Tokens | null {
  const raw = storage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

export function signOutUrl(endpoints: AuthEndpoints, storage: Storage): string {
  storage.removeItem(TOKENS_KEY);
  const url = new URL(`https://${endpoints.authDomain}/logout`);
  url.search = new URLSearchParams({
    client_id: endpoints.clientId,
    logout_uri: endpoints.redirectUri,
  }).toString();
  return url.toString();
}

/** Display only. The signature is verified by API Gateway and the api, never here. */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return (JSON.parse(json) as { email?: string }).email ?? null;
  } catch {
    return null;
  }
}
