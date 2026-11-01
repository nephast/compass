import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { ApiConfig } from "./config.js";

// API Gateway's JWT authorizer already rejects a missing or invalid token at
// the edge (COMPASS-16) -- that is where the 401 in the acceptance criterion
// comes from. The service verifies the token AGAIN, for two reasons:
//
//   1. Defence in depth. The internal ALB is reachable from inside the VPC;
//      anything that lands in a private subnet must not be able to call the
//      api as an arbitrary user by setting a header.
//   2. The claims. HTTP API proxy integrations do not pass the authorizer's
//      decoded claims through, so the service needs the token to learn `sub`.
//
// Verification is local (signature against Cognito's JWKS, cached after the
// first fetch), so the second check costs microseconds, not a network call.

export interface Caller {
  sub: string;
  username: string | undefined;
}

export class Unauthorized extends Error {
  readonly statusCode = 401;
}

export type Authenticate = (
  headers: Record<string, string | string[] | undefined>,
) => Promise<Caller>;

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createAuthenticator(config: ApiConfig): Authenticate {
  if (config.authMode === "dev") {
    // Local only (enforced in loadConfig): the caller names themselves.
    return async (headers) => {
      const sub = header(headers, "x-dev-user");
      if (!sub) throw new Unauthorized("x-dev-user header required in dev auth mode");
      return { sub, username: sub };
    };
  }

  const cognito = config.cognito as NonNullable<ApiConfig["cognito"]>;
  // Access tokens, not ID tokens: an access token is the credential meant for
  // resource servers, and it is what the gateway authorizer validates too
  // (its `client_id` claim is checked against the configured audience).
  const verifier = CognitoJwtVerifier.create({
    userPoolId: cognito.userPoolId,
    clientId: cognito.clientId,
    tokenUse: "access",
  });

  return async (headers) => {
    const authorization = header(headers, "authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new Unauthorized("missing bearer token");
    try {
      const payload = await verifier.verify(token);
      return { sub: payload.sub, username: payload.username };
    } catch {
      // The reason (expired, wrong client, bad signature) is not returned to
      // the caller: it helps an attacker tune a forged token more than it
      // helps a legitimate client, whose only remedy is to sign in again.
      throw new Unauthorized("invalid token");
    }
  };
}
