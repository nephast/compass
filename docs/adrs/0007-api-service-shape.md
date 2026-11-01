# ADR-0007: API service shape — Fastify, re-verified JWTs, ownership in the object key

**Status:** Proposed
**Date:** 2026-11-01
**Deciders:** nephast

## Context

`apps/api` is the only synchronous entry point behind API Gateway (COMPASS-16/17).
It presigns uploads, lists a caller's documents, answers RAG queries (COMPASS-20)
and forwards agent requests to `agent-tools`. Three decisions shape it.

## Decision

1. **Fastify** as the HTTP framework.
2. **The service verifies the Cognito access token itself**, even though the API
   Gateway JWT authorizer has already verified it.
3. **Ownership travels in the S3 object key** (`uploads/<sub>/<uuid>/<name>`),
   built by the api at presign time and parsed back by the ingestion Lambda.

## Options Considered

### 1. Framework

| | Fastify | Express | Hono |
|---|---|---|---|
| Request validation | JSON Schema built in (Ajv) | middleware of choice | validator middleware |
| TypeScript | first-class generics on routes | `@types`, loose | first-class |
| Maturity on Node | high | highest | newer, edge-first |

**Fastify** wins on validation: body schemas reject bad input before a handler runs,
and the schema is also the documentation. Express would need a validation library
bolted on; Hono's strengths (edge runtimes) are irrelevant on EKS.

### 2. Where the JWT is checked

- **Gateway only**, trusting a header the gateway sets. Cheapest, but the internal
  ALB is reachable from anything in the private subnets; a compromised pod or a
  misrouted request could act as any user by setting one header.
- **Gateway and service** (chosen). Verification is local — signature against a
  cached JWKS — so it costs microseconds. HTTP API proxy integrations also do not
  pass decoded claims through, so the service needs the token to learn `sub` anyway.

### 3. How ownership reaches the async pipeline

- **Key prefix** (chosen): no extra infrastructure; the client cannot choose the
  prefix because it never builds the key.
- **S3 object metadata / tags**: also works, but the client sends them on the PUT,
  so they would need to be signed into the URL and still be re-checked.
- **A pending row written at presign time**: the cleanest audit trail, but adds a
  write path, and orphaned rows for uploads that never happen.

## Consequences

- Retrieval is owner-scoped in SQL (`documents.owner_sub`), so one user's query
  never searches another's documents. Documents with no owner (put by hand) are
  unreachable from the API rather than visible to everyone.
- The HNSW index is global and the owner filter applies after the approximate
  search; pgvector 0.8's iterative scan (`hnsw.iterative_scan`) compensates. Per-
  tenant partitioning is the next step at scale (`docs/SCALING.md`).
- `AUTH_MODE=dev` (trust an `x-dev-user` header) exists for local work only and the
  service refuses to start with it unless `LOCALSTACK_ENDPOINT` is set.
- Health checks touch no dependency, so a database outage degrades queries rather
  than causing Kubernetes to restart every pod at once.

## Action Items

1. [x] Fastify service with schema-validated routes, structured logs, trace ids
2. [x] `aws-jwt-verify` against the user pool, access tokens only
3. [ ] Revisit the key-prefix scheme if documents ever need sharing between users
