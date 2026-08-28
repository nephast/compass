// Runs the migrations in ../migrations against whichever database the
// environment points at. Deliberately not a `node-pg-migrate` CLI invocation:
// the CLI wants a DATABASE_URL string, and against RDS the password is a
// 15-minute IAM token that has to be minted at connect time.
//
// Two supported shapes:
//
//   DATABASE_URL=postgres://compass:compass@localhost:5432/compass   (local container)
//   DB_HOST=<rds endpoint> DB_USER=compass_migrator DB_NAME=compass  (IAM auth)
//
// See apps/db/README.md for the port-forwarded RDS run.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Signer } from "@aws-sdk/rds-signer";
import { runner } from "node-pg-migrate";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const log = (message) => process.stdout.write(`${message}\n`);

function required(name) {
  const value = process.env[name];
  // An empty string is the failure mode that actually happens -- an unset shell
  // variable interpolated into a command -- and it produces a misleading
  // connection error several seconds later rather than an error here.
  if (!value) throw new Error(`${name} is required (unset or empty)`);
  return value;
}

async function buildConnection() {
  if (process.env.DATABASE_URL) {
    log("connecting via DATABASE_URL (password auth)");
    return process.env.DATABASE_URL;
  }

  // The hostname the token is signed for and the certificate is checked
  // against. When tunnelling, this stays the real RDS endpoint even though the
  // socket goes to localhost -- the signature covers host:port:user, and a
  // token minted for "localhost" is rejected.
  const host = required("DB_HOST");
  const port = Number(process.env.DB_PORT ?? 5432);
  const user = required("DB_USER");
  const database = required("DB_NAME");

  const signer = new Signer({ hostname: host, port, username: user, region: required("AWS_REGION") });
  // No network call: this is a SigV4 signature computed locally, which is why
  // it works from inside a private subnet with no route to the RDS API.
  const password = await signer.getAuthToken();

  // Verify-full or nothing. On a bearer-token scheme, skipping verification
  // hands anyone in the connection path a credential they can replay for
  // fifteen minutes.
  const ca = readFileSync(required("DB_SSL_ROOT_CERT"), "utf8");
  const tunnelPort = process.env.DB_TUNNEL_PORT;

  log(
    tunnelPort
      ? `connecting to ${host}:${port} via 127.0.0.1:${tunnelPort} as ${user} (IAM auth)`
      : `connecting to ${host}:${port} as ${user} (IAM auth)`,
  );

  return {
    host: tunnelPort ? "127.0.0.1" : host,
    port: tunnelPort ? Number(tunnelPort) : port,
    user,
    database,
    password,
    // `servername` drives both SNI and certificate identity checking, so the
    // certificate is still validated against the real endpoint when the socket
    // is pointed at a local tunnel.
    ssl: { ca, servername: host },
  };
}

const direction = process.argv[2] === "down" ? "down" : "up";

const { migrations, appliedCount } = await (async () => {
  const applied = await runner({
    databaseUrl: await buildConnection(),
    dir: MIGRATIONS_DIR,
    direction,
    // Down is destructive, so it moves one step at a time and only when asked.
    ...(direction === "down" ? { count: 1 } : {}),
    migrationsTable: "pgmigrations",
    // All-or-nothing: a half-applied schema is worse than a failed deploy.
    singleTransaction: true,
    checkOrder: true,
    log,
  });
  return { migrations: applied, appliedCount: applied.length };
})();

// This line is the acceptance criterion made observable: the second run of a
// migration that is already applied has to print zero.
log(`${direction}: ${appliedCount} migration(s) applied${appliedCount ? `: ${migrations.map((m) => m.name).join(", ")}` : ""}`);
