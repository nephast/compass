# @compass/db — schema and migrations (COMPASS-14)

The database's shape is owned here, in ordered SQL files, and nowhere else.
Nothing at runtime issues DDL.

```bash
npm run migrate            # from the repo root; up to latest
npm run migrate:down -w @compass/db   # one step back, deliberately manual
```

## Why a migration tool and not `CREATE TABLE IF NOT EXISTS`

The scaffold used to create its tables from inside the ingestion handler. That
costs four things: the application role needs `CREATE` forever (so a compromised
handler can `DROP`), `IF NOT EXISTS` silently tolerates a table of the *wrong*
shape, there is no ordered history to rebuild an environment from, and a schema
change never appears in a PR diff. Building the HNSW index on a request path
would have been the fifth.

`node-pg-migrate` with plain SQL, over Prisma or Drizzle: pgvector's useful
surface (HNSW operator classes, index tuning) is exactly what an ORM abstracts
worst, and every retrieval query in this project is hand-written SQL anyway. See
`docs/adrs/`.

## Local

`npm run local:up` migrates the compose container automatically — `bootstrap`
defaults `DATABASE_URL` to the compose credentials.

## Against RDS

The instance is in a private subnet with no public address, and the migration
role authenticates with a 15-minute IAM token rather than a password. Hence the
script rather than the CLI: the token is minted at connect time.

Bring up a jump host with the app security group (steps 1 and 5 of
`docs/runbooks/database-bootstrap.md` — including destroying it afterwards),
then tunnel to it:

```bash
export AWS_REGION=eu-west-1
DB_HOST=$(aws ssm get-parameter --name /compass/dev/db/endpoint --query Parameter.Value --output text)
curl -sS -o /tmp/rds-ca.pem https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem

aws ssm start-session --target "$INSTANCE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$DB_HOST,portNumber=5432,localPortNumber=15432"
```

In a second shell:

```bash
DB_HOST="$DB_HOST" DB_USER=compass_migrator DB_NAME=compass \
DB_TUNNEL_PORT=15432 DB_SSL_ROOT_CERT=/tmp/rds-ca.pem AWS_REGION=eu-west-1 \
  npm run migrate
```

`DB_HOST` stays the real endpoint even though the socket goes to localhost. The
IAM token is signed over host:port:user, so a token minted for `localhost` is
rejected, and TLS verification uses the same name via the TLS `servername`
option — this is `verify-full` for real, not `sslmode=require` with the checking
switched off.

## Roles

Three, with different powers, which is the point:

| role | authenticates by | can |
| --- | --- | --- |
| `compass_admin` | master password in Secrets Manager | anything; used once, at bootstrap |
| `compass_migrator` | IAM token | DDL on `public` — runs this package |
| `compass_app` | IAM token | `SELECT/INSERT/UPDATE/DELETE` only |

The application can therefore never alter the schema, and no long-lived password
exists in either the migration path or the runtime path.
