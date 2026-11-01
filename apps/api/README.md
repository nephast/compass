# apps/api

The core API service on EKS (ADR-0003, ADR-0007). Everything a browser can ask
for goes through here, behind API Gateway's JWT authorizer.

**Tickets:** COMPASS-9 (presign), COMPASS-17 (service), COMPASS-20 (RAG)

## Routes

| Method | Path | Auth | Does |
|---|---|---|---|
| GET | `/healthz` | none | Liveness/readiness. Touches no dependency, deliberately. |
| POST | `/documents/upload-url` | JWT | `{fileName, size}` → presigned PUT under `uploads/<sub>/<uuid>/<name>`, size + type signed in |
| GET | `/documents` | JWT | The caller's documents with ingestion status and failure reason |
| POST | `/query` | JWT | `{question}` → RAG answer with numbered citations |
| POST | `/agent` | JWT | `{message}` → forwarded to `agent-tools` (read-only ops tools) |

Errors are `{error, traceId}`. 5xx never carry internals; quote the trace id.

## RAG flow (`src/rag.ts`)

1. Embed the question with the same `EmbeddingProvider` as ingestion.
2. Top-k by cosine distance, **filtered to the caller's documents**, current model only.
3. Drop hits beyond `RAG_MAX_DISTANCE`. **If none remain, return "I couldn't find
   that in your documents." without calling the model** — the only reliable way
   to stop it answering from its own knowledge.
4. Widen each hit with its neighbouring chunks and merge adjacent ones into passages.
5. Prompt: answer only from numbered passages, cite `[n]`, or reply with the
   exact not-found sentence. Passage text is declared data, not instructions.
6. Return the answer plus only the passages it cited.

`RAG_MAX_DISTANCE` is per embedding model. Titan V2 default `0.75`; calibrate it by
running a few known-answer and known-absent questions and reading `bestDistance`
from the `rag retrieval` log line.

## Configuration

| Variable | Default | |
|---|---|---|
| `DOCUMENTS_BUCKET` | — | required |
| `AUTH_MODE` | `cognito` | `dev` only with `LOCALSTACK_ENDPOINT` set |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | — | required in `cognito` mode |
| `AGENT_TOOLS_URL` | `http://agent-tools.compass.svc.cluster.local` | |
| `RAG_TOP_K` / `RAG_MAX_DISTANCE` | `5` / `0.75` | |
| `DATABASE_URL` **or** `DB_HOST`+`DB_USER`+`DB_NAME`+`AWS_REGION` | — | see `packages/pg` |
| `LLM_*` | — | see `packages/llm` |

## Run locally

```bash
npm run local:up
AUTH_MODE=dev LLM_EMBEDDING_PROVIDER=fake LLM_COMPLETION_PROVIDER=fake \
  DOCUMENTS_BUCKET=compass-raw-documents npm run dev -w @compass/api
curl -H 'x-dev-user: me' localhost:8080/documents
```

## Image

`docker build -f apps/api/Dockerfile .` from the repo root (workspaces). One
bundled file on `node:24-alpine`, npm removed, runs as uid 1000, RDS CA baked in.
