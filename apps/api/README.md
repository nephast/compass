# apps/api

The core API service on EKS (ADR-0003, ADR-0007). Everything a browser can ask
for goes through here, behind API Gateway's JWT authorizer.

**Tickets:** COMPASS-9 (presign), COMPASS-17 (service)

## Routes

| Method | Path                    | Auth | Does                                                                                          |
| ------ | ----------------------- | ---- | --------------------------------------------------------------------------------------------- |
| GET    | `/healthz`              | none | Liveness/readiness. Touches no dependency, deliberately.                                      |
| POST   | `/documents/upload-url` | JWT  | `{fileName, size}` → presigned PUT under `uploads/<sub>/<uuid>/<name>`, size + type signed in |
| GET    | `/documents`            | JWT  | The caller's documents with ingestion status and failure reason                               |

Errors are `{error, traceId}`. 5xx never carry internals; quote the trace id.

## Configuration

| Variable                                                         | Default   |                                           |
| ---------------------------------------------------------------- | --------- | ----------------------------------------- |
| `DOCUMENTS_BUCKET`                                               | —         | required                                  |
| `AUTH_MODE`                                                      | `cognito` | `dev` only with `LOCALSTACK_ENDPOINT` set |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`                      | —         | required in `cognito` mode                |
| `DATABASE_URL` **or** `DB_HOST`+`DB_USER`+`DB_NAME`+`AWS_REGION` | —         | see `packages/pg`                         |
| `LLM_*`                                                          | —         | see `packages/llm`                        |

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
