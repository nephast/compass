# Runbook: local development loop (COMPASS-4)

## Prerequisites

- Docker running (LocalStack executes Lambdas by starting runtime containers
  on the host's Docker daemon — that's why `docker-compose.yml` mounts
  `/var/run/docker.sock`)
- Node 24 (`.nvmrc`)

## Setup

```bash
cp .env.example .env   # fill in values, never commit this file
npm install
npm run local:up       # docker compose up -d --wait, then create the S3 bucket
```

`local:up` waits for the container healthchecks before running the bootstrap,
so nothing races a database that isn't accepting connections yet. It's
idempotent — re-run it whenever you want.

Tear it down with `npm run local:down` (add `-v` to `docker compose down`
yourself if you want the Postgres volume gone too).

## The loop

```bash
npm run dev            # local:up + vitest in watch mode on the unit + integration tiers
```

Or, per workspace: `npm run dev -w @compass/ingestion`.

## Test tiers

Tiers are directories, so the scripts that select them stay obvious.

| Tier | Path | Needs Docker? | Runs where |
|---|---|---|---|
| unit | `test/unit` | no | every save, and in CI (`npm test`) |
| integration | `test/integration` | LocalStack + Postgres | every save (`npm run test:integration`) |
| wiring | `test/wiring` | LocalStack + Postgres + docker.sock | before opening a PR (`npm run test:wiring`) |

The split exists because the wiring tier bundles the handler, deploys it as a
real Lambda and waits for an asynchronous S3 notification — minutes on a cold
LocalStack. That's a fine acceptance test and a terrible save-loop. The
integration tier runs the *same handler* in-process against the same
LocalStack S3 and Postgres in about a second; it proves the logic, and the
wiring tier proves the plumbing.

CI currently runs the unit tier only — `pr-checks.yml` has no LocalStack
service container yet (COMPASS-25).

## What runs against LocalStack vs real AWS

Everything in the ingestion pipeline (S3 events, SQS, Step Functions, Lambda
invocation) should be developable and testable against LocalStack — you
should rarely need to deploy to real AWS just to iterate on handler logic.
Real AWS is for: Bedrock (LocalStack doesn't mock it usefully — use a
cheap/free OpenRouter model for local iteration instead, per the
`LlmProvider` abstraction, COMPASS-19), and anything you're specifically
testing end-to-end pre-deploy.

`LOCALSTACK_ENDPOINT` is the only switch: when it's set, `aws-config.ts`
points every SDK client at LocalStack with dummy credentials. Unset, clients
resolve real endpoints through the normal SDK chain. No application code
branches on an environment name.

## Database schema

There isn't a migration tool yet (COMPASS-14). `src/chunk-store.ts` creates
the `vector` extension and the `chunks` table on demand, once per process.
It's deliberately the only owner of the schema — the bootstrap script only
creates the S3 bucket — so there's nothing to drift.

## `kubectl` access to the real EKS cluster

```bash
aws eks update-kubeconfig --name compass-dev --region <region>
kubectl get nodes
kubectl get pods -n compass
```

## Common issues

**`npm run test:wiring` hangs or times out on the first run.** LocalStack
pulls the Lambda runtime image on first use; that can take well over a
minute. The `beforeAll` budget is 180s. Second run is fast.

**Lambda is created but never invoked.** Check the `docker.sock` mount in
`docker-compose.yml`. Without it `CreateFunction` succeeds and `Invoke`
silently never runs.

**`ECONNREFUSED localhost:4566` / `localhost:5432`.** Containers aren't up or
aren't healthy yet — `npm run local:up` (not a bare `docker compose up -d`)
waits for health.

**Postgres `role "compass" does not exist` after changing compose env vars.**
The Postgres image only initialises on an empty volume: `docker compose down
-v` and bring it back up.
