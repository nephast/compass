# ADR-0002: Vector Store for RAG Retrieval

**Status:** Accepted
**Date:** 2026-08-22
**Deciders:** Stéphan (solo project)

## Context

The RAG pipeline needs a store for document chunk embeddings that supports approximate nearest-neighbor similarity search, is reachable from both the serverless ingestion Lambdas and the EKS `api` service, and fits a free-tier / $100-credit budget for a two-week project — while still being a pattern worth putting on a resume.

## Decision

Use **Amazon RDS for PostgreSQL (`db.t3.micro`) with the `pgvector` extension** as the vector store.

## Options Considered

### Option A: Amazon OpenSearch Service (managed, not Serverless)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | No meaningful free tier beyond a small always-free instance type in limited regions; a usable dev domain runs $25–50+/mo |
| Scalability | High — purpose-built for this |
| Team familiarity | Medium |

**Pros:** purpose-built, k-NN plugin is mature, scales well beyond this project's needs.
**Cons:** cost floor is the highest of the three options; overkill for a corpus of demo documents.

### Option B: Amazon OpenSearch Serverless
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low (no cluster management) |
| Cost | Billed in OCUs with a non-trivial minimum (multiple OCUs minimum even at idle) — no free tier |
| Scalability | High, scales to zero traffic but not to zero cost |
| Team familiarity | Low — newer service |

**Pros:** "serverless" fits the event-driven story, no capacity planning.
**Cons:** the OCU minimum makes it the most expensive **idle** option of the three — bad fit for a project mostly sitting idle between build sessions.

### Option C: RDS Postgres + pgvector
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low-medium — one extra extension, otherwise standard RDS |
| Cost | `db.t3.micro` is inside the 12-month AWS free tier (750 instance-hours/month) |
| Scalability | Good to tens of millions of vectors with proper indexing (IVFFlat/HNSW); would need to migrate at real scale |
| Team familiarity | High — it's just Postgres |

**Pros:** free-tier eligible, doubles as the relational store for everything else the app needs (users' document metadata, ingestion job status), one fewer service to secure/monitor/pay for, IAM database authentication is a genuinely good thing to have built once.
**Cons:** not purpose-built for vector search; would need a real migration (to OpenSearch, Pinecone, etc.) if this ever needed to handle millions of documents in production.

## Trade-off Analysis

At this project's scale (a personal document corpus, not a multi-tenant SaaS with millions of vectors), pgvector's ceiling is nowhere close to being a real constraint, and its cost floor — effectively zero, riding the free tier — is unambiguously the right trade for a two-week budget-constrained build. The honest interview answer is straightforward: "pgvector because it was free-tier eligible and I already needed Postgres for metadata; I'd re-evaluate against a purpose-built vector store past roughly 1–10M vectors or once query latency under concurrent load became the bottleneck, and I can point to the specific index type (HNSW) and its recall/latency trade-off vs IVFFlat as the first thing I'd tune before migrating."

## Consequences

- Easier: one fewer AWS service to provision, secure, and pay for; relational + vector data live together, so joins between "which user uploaded this chunk" and "what's semantically similar" are trivial SQL, not cross-service calls.
- Harder: no built-in horizontal scaling for the vector index; you own choosing and tuning the pgvector index type; RDS Multi-AZ (for real HA) is not free-tier eligible, so this stays single-AZ, another documented trade-off.
- Revisit: if this ever needed >1M vectors, sub-50ms p99 retrieval under concurrent load, or multi-region — migrate to a purpose-built vector store then, not now.

## Action Items

1. [ ] Terraform: `db.t3.micro` Postgres instance, private subnet, security group scoped to EKS node SG + Lambda SG only.
2. [ ] Enable `pgvector` extension via a migration (see `apps/api` migration tooling — Epic 3).
3. [ ] Use IAM database authentication (no long-lived DB password in Secrets Manager) — see ADR on secrets handling in `docs/runbooks/security-baseline.md`.
4. [ ] Choose and document HNSW vs IVFFlat index parameters once real query latency is measured — don't guess upfront.
