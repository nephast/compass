# apps/ingestion

The ingestion Lambda: an uploaded object becomes ordered chunks with real
embeddings in pgvector. See `docs/ARCHITECTURE.md` for where it sits.

**Tickets:** COMPASS-9 – COMPASS-12 (see `docs/PROGRAM.md`)

## Flow (deployed)

```
S3 ObjectCreated ─▶ EventBridge rule ─▶ Step Functions (retry + catch) ─▶ this Lambda ─▶ RDS/pgvector
```

Locally, LocalStack invokes the same handler straight from an S3 notification
(`test/wiring`), or `npm run watch` polls the bucket and calls it directly.
`parseIngestEvent` accepts both event shapes (they encode keys differently: S3
notifications URL-encode them, EventBridge does not).

## What one invocation does (`src/ingest.ts`)

1. Fetch the object (5 MiB cap, checked before the body is read).
2. `beginDocument`, the idempotency gate (COMPASS-12):
   - same key, same bytes, already embedded with the current model → `unchanged`
   - the same owner already has these bytes under another key → `duplicate`, never embedded
   - otherwise upsert the `documents` row as `pending`
3. Decode (`.txt` / `.md`, strict UTF-8) → chunk (`src/chunker.ts`) → embed via `LlmProvider`.
4. `storeChunks`: one short transaction that upserts chunks and vectors, deletes
   stale tail ordinals, and marks the document `embedded`.

Unsupported, empty, undecodable or oversize objects are **recorded** as `failed`
with a `failure_reason` and are not retried: retrying a PDF will never make it
text. An embedding error is recorded *and* rethrown, so Step Functions retries it
(usually throttling).

## Descoped (29 Aug cut)

The original design split this into chunk → SQS (+DLQ) → embed → store. The
reasoning for not doing that, and the cost of adding it later, is on the
COMPASS-11 issue. Step Functions' retry/catch now plays the DLQ's role.

## Tests

| tier | needs | runs |
| --- | --- | --- |
| `npm test -w @compass/ingestion` | nothing | chunker, decoding, key + event parsing |
| `npm run test:integration -w @compass/ingestion` | `npm run local:up` | the real pipeline against LocalStack S3 + pgvector, fake embedder |
| `npm run test:wiring -w @compass/ingestion` | `npm run local:up` | deploys the bundled handler into LocalStack Lambda |
