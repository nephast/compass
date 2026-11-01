import { readFileSync } from "node:fs";
import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";

// One way to get a Postgres pool, for every runtime in the repo: the ingestion
// Lambda, the api pod, and tests. Two shapes, chosen by environment:
//
//   DATABASE_URL=postgres://...                 local container, password auth
//   DB_HOST + DB_USER + DB_NAME (+ DB_PORT)     RDS, IAM auth token per connection
//
// The IAM shape is the one ADR-0004 commits to. The token is a 15-minute
// bearer credential, so it is minted per *connection* (pg calls `password` on
// every new physical connection) rather than once at boot -- a pool that
// outlives its token would otherwise fail every reconnect after 15 minutes.

export interface PgEnv {
  DATABASE_URL?: string | undefined;
  DB_HOST?: string | undefined;
  DB_PORT?: string | undefined;
  DB_USER?: string | undefined;
  DB_NAME?: string | undefined;
  /** PEM bundle for verify-full. Defaults to the file baked into the image. */
  DB_SSL_ROOT_CERT?: string | undefined;
  AWS_REGION?: string | undefined;
}

export type ConnectionPlan =
  | { kind: "url"; connectionString: string }
  | {
      kind: "iam";
      host: string;
      port: number;
      user: string;
      database: string;
      region: string;
      caPath: string | undefined;
    };

/** Pure: decides how to connect without connecting. Unit-tested. */
export function planConnection(env: PgEnv): ConnectionPlan {
  if (env.DATABASE_URL) return { kind: "url", connectionString: env.DATABASE_URL };

  const missing = (["DB_HOST", "DB_USER", "DB_NAME", "AWS_REGION"] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    // Named, not a generic "cannot connect": the failure that actually happens
    // is one variable missing from a Deployment manifest, and pg's own error
    // for that is a connection refused to localhost several seconds later.
    throw new Error(
      `no DATABASE_URL, and IAM auth is missing ${missing.join(", ")} — set one shape or the other`,
    );
  }

  const port = Number(env.DB_PORT ?? 5432);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`DB_PORT "${env.DB_PORT}" is not a port`);

  return {
    kind: "iam",
    host: env.DB_HOST as string,
    port,
    user: env.DB_USER as string,
    database: env.DB_NAME as string,
    region: env.AWS_REGION as string,
    caPath: env.DB_SSL_ROOT_CERT,
  };
}

export interface PoolOptions {
  /** Kept small on purpose: db.t3.micro allows ~80 connections in total. */
  max?: number;
}

export function createPool(env: PgEnv = process.env, options: PoolOptions = {}): pg.Pool {
  const plan = planConnection(env);
  const max = options.max ?? 5;

  if (plan.kind === "url") return new pg.Pool({ connectionString: plan.connectionString, max });

  const signer = new Signer({
    hostname: plan.host,
    port: plan.port,
    username: plan.user,
    region: plan.region,
  });

  return new pg.Pool({
    host: plan.host,
    port: plan.port,
    user: plan.user,
    database: plan.database,
    // A SigV4 signature computed locally -- no network call, so it works from a
    // private subnet with no route to the RDS API.
    password: () => signer.getAuthToken(),
    // Verify-full or nothing: skipping verification on a bearer-token scheme
    // hands anyone in the path a credential replayable for 15 minutes. When no
    // CA path is given, Node's bundled roots are used, which include Amazon's.
    ssl: plan.caPath
      ? { ca: readFileSync(plan.caPath, "utf8"), servername: plan.host }
      : { rejectUnauthorized: true, servername: plan.host },
    max,
    idleTimeoutMillis: 60_000,
  });
}

export type { Pool, PoolClient } from "pg";
