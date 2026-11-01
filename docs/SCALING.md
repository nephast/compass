# Scaling Compass (COMPASS-34)

How this system breaks as traffic grows, written about the components that were
actually built, with their actual limits. Numbers marked *estimate* are reasoned
from published limits, not load-tested.

## Current design point

A handful of users, a few hundred documents, single-digit requests per second.
Optimised for **cost and learning depth**, not throughput. The configured ceilings:

| Component | Configured limit | Where |
|---|---|---|
| API Gateway stage throttle | **20 rps**, burst 40 (whole API, not per user) | `infra/cdk/lib/api-stack.ts` |
| api pods | 2 → 4 (HPA at 70% of a 100m CPU request) | `infra/k8s/base/api.yaml` |
| EKS nodes | 2 × `t3.small`, max 3, **no node autoscaler** | `modules/eks` |
| Pods per node | 11 (ENI limit for `t3.small`) | AWS VPC CNI |
| Database | `db.t3.micro`: 2 burstable vCPU, 1 GiB RAM, ~80 connections, single-AZ | `modules/rds` |
| DB connections in use | api 5 × pods + Lambda 2 × 5 = **≤ 30** | `packages/pg`, ingestion stack |
| Ingest Lambda | reserved concurrency **5**, 5-minute timeout, 5 MiB documents | `ingestion-stack.ts` |
| Outbound internet | one `t3.micro` NAT **instance**, one AZ | `modules/vpc` (ADR-0001) |
| Agent | ≤ 5 tool calls, ≤ 6 model turns per request | `apps/agent-tools` |

## First bottleneck at 10x traffic

**The cluster cannot add nodes.** The HPA will scale the api to 4 pods, but the
node group has no Cluster Autoscaler or Karpenter, so once two `t3.small` nodes
are full (11 pods each, ~6 already taken by system DaemonSets and add-ons) new pods
sit in `Pending`. Pods stop scaling long before CPU or the database becomes the issue.

Close behind it, and deliberately:

- **The 20 rps stage throttle** returns `429` before any of that matters. It is an
  abuse control sized for a demo, not a capacity statement.
- **Latency is the model, not the stack.** A RAG query is one embedding call
  (~100 ms) plus one completion (Nova Lite, ~1–3 s). The api spends most of its time
  waiting, so 4 pods handle far more concurrent queries than their CPU suggests.
  Throughput at 10x is bounded by Bedrock on-demand quotas long before api CPU.
- **`db.t3.micro` CPU credits.** HNSW inserts during a bulk upload burn burstable
  credits; once they're gone the instance runs at its 10% baseline and every query
  slows down. This shows on the dashboard as a slow, global latency rise, not errors.

## First bottleneck at 100x traffic

This is where the design changes *qualitatively*:

1. **The vector index outgrows RAM.** A 1024-dimension `float4` vector is 4 KiB;
   HNSW adds graph overhead. With 1 GiB of RAM, the index stops fitting in memory at
   roughly 100–150k chunks *(estimate)*, and every query turns into random disk reads.
   Retrieval latency goes from milliseconds to hundreds of milliseconds, and
   `iterative_scan` (which compensates for the owner filter) makes it worse: it keeps
   reading index pages until enough of *this* user's rows turn up.
2. **The global index plus owner filter stops being fair.** One user with 100k chunks
   and one with 10 share an HNSW graph. The small user's query has to walk past the
   large user's neighbours. Per-tenant cost becomes unpredictable.
3. **Ingestion serialises on Bedrock.** Titan embeds one text per call (no batch API).
   A 5 MiB document is ~5,000 chunks, which means 5,000 calls at 8 in flight per
   Lambda × 5 Lambdas. Bulk uploads hit the account's Titan TPS quota, retries back
   off, and the 5-minute timeout turns large documents into `FAILED` executions.
   This is exactly the failure the descoped SQS design (COMPASS-11) existed to absorb.
4. **The NAT instance carries every Bedrock call.** It is one `t3.micro` in one AZ with
   a low baseline network allowance. At 100x it is both a bandwidth ceiling and the
   single point of failure for every model call.

## What I'd change first, in order

1. **Node autoscaling (Karpenter), then lift the API throttle.** Cheapest fix with the
   biggest effect. Karpenter over Cluster Autoscaler: it picks instance types per
   pending pod rather than scaling a fixed group. Raise the stage throttle to match,
   and add *per-user* limiting (CloudFront + WAF in front of the API, ADR-0009 option B).
2. **Put the queue back into ingestion.** Chunk → SQS (with DLQ) → embed consumers whose
   concurrency is tuned to the Bedrock quota → store. The schema already separates
   `documents` / `chunks` / `embeddings`, and idempotency lives in unique constraints,
   so this is additive (COMPASS-11's "cost of adding it later"). Ask AWS for a Titan
   quota increase in parallel.
3. **A real database tier.** Aurora PostgreSQL (or RDS on `r7g.large`+) with pgvector,
   sized so the HNSW index sits in RAM; **RDS Proxy** in front (connection pooling, and
   IAM auth already works through it); a **read replica** for retrieval, so bulk
   ingestion writes stop competing with queries; Multi-AZ.
4. **Partition retrieval by tenant.** Either list-partition `embeddings` by owner
   (small tenants stop walking the big tenant's graph), or move the vector tier to a
   service with native filtered search (OpenSearch with filtered k-NN). ADR-0002's cost
   argument against OpenSearch flips once the database itself costs hundreds a month.
5. **Replace the NAT instance** with a NAT Gateway per AZ, plus interface endpoints for
   `bedrock-runtime`, ECR and Logs, so model traffic never leaves AWS's network and no
   single instance sits on the path.
6. **Caching.** Question embeddings (same question → same vector) and agent tool
   results (Cost Explorer data is daily and each call costs $0.01) for an hour.

## What I deliberately did NOT build for scale, and why

| Choice | Why it's fine here | ADR |
|---|---|---|
| NAT instance, not NAT Gateway | ~$32/month saved on a $100 credit | ADR-0001 |
| pgvector on one `t3.micro` | Same transferable skill as a big instance, a fraction of the cost | ADR-0002 |
| Single-AZ RDS, 1-day backups | Multi-AZ doubles the price for availability a demo doesn't need | `modules/rds` |
| No node autoscaler | Two nodes are enough; Karpenter is another controller to run | ADR-0003 follow-up |
| Single Lambda, no SQS | Resilience at a corpus size this project won't reach; the Step Functions retry stands in for the DLQ | COMPASS-11 issue |
| Plain HTTP between VPC Link → ALB → nodes | TLS ends at API Gateway; inside the VPC this needs a private CA (~$400/month) | `modules/ingress` |
| Interface endpoints off | ~$64/month for resilience to a NAT outage | `modules/vpc` |
| VPC flow logs off | Per-GB ingest cost; first thing to add for anything long-lived | `modules/vpc` |
| CloudFront default certificate | No custom domain, so the TLS policy is CloudFront's default; a custom domain + ACM lets it be pinned to TLS 1.2+ | `frontend-stack.ts` |

## Cost at scale

**Today, running 24/7** (eu-west-1, on-demand list prices, *estimate*):

| Line item | ~$/month |
|---|---|
| EKS control plane | 73 |
| 2 × `t3.small` nodes | 30 |
| `db.t3.micro` + 20 GiB gp3 | 17 |
| Internal ALB | 18 |
| WAF (1 ACL, 3 rules) | 8 |
| NAT instance (`t3.micro`) | 8 |
| KMS, Secrets Manager, CloudWatch, Step Functions, Lambda, S3, CloudFront | ~5 |
| **Total** | **~159** |

That's why the teardown habit matters: the $100 credit buys about **19 days** of
always-on, or a few months of four-hour sessions.

**1,000 real users** (~10 queries/user/day, ~50 documents each, *estimate*):

- Bedrock is the biggest variable cost. 10k queries/day × (~2k input + ~300 output
  tokens) on Nova Lite is roughly **$1–2/day**. On Claude Haiku-class models,
  **$15–25/day**. The model choice dominates the bill more than any infrastructure decision.
- Embedding 50k documents once is a one-off, a few dollars on Titan V2.
- Infrastructure after the changes above (Karpenter nodes, Aurora `r7g.large` +
  replica, RDS Proxy, NAT Gateways ×2, endpoints): roughly **$900–1,100/month**.

**Single biggest line item at 1,000 users: the database tier**, unless the
completion model is upgraded, in which case it's Bedrock.
