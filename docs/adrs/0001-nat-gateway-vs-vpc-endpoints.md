# ADR-0001: Outbound Connectivity for Private Subnets — NAT Gateway vs VPC Endpoints

**Status:** Accepted
**Date:** 2026-08-22
**Deciders:** Stéphan (solo project)

## Context

EKS nodes and the RDS instance live in private subnets with no public IPs (see `docs/ARCHITECTURE.md`). They still need to reach: the EKS control plane, ECR (to pull images), CloudWatch Logs, Secrets Manager, S3, and external HTTPS endpoints (Bedrock, OpenRouter, GitHub API, AWS Cost Explorer).

Constraints: this runs on a new AWS account funded by free tier + a $100 credit budget for two weeks, then gets torn down or scaled to near-zero. A NAT Gateway costs ~$0.045/hr (~$32/month if left running) plus ~$0.045/GB processed — not free-tier eligible, and the single biggest "I forgot this was running" cost risk in this architecture. VPC endpoints (Interface and Gateway) have their own cost profile: Gateway endpoints (S3, DynamoDB) are free; Interface endpoints (ECR, CloudWatch Logs, Secrets Manager, STS) cost ~$0.01/hr **per endpoint per AZ** plus data processing — cheaper than a NAT Gateway if you need few of them, comparable or worse if you need many across multiple AZs.

## Decision

Use VPC Gateway endpoints for S3 (free) and Interface endpoints for ECR, CloudWatch Logs, and Secrets Manager, single-AZ only (accepting reduced HA for a portfolio project). Do **not** provision a NAT Gateway. For the small number of calls that must reach the public internet (Bedrock if not using its VPC endpoint, OpenRouter, GitHub API, Cost Explorer), route through a single **NAT instance** (a small EC2 instance running as a NAT, `t3.nano` or `t4g.nano`) instead — cheaper than a NAT Gateway and, crucially, something you fully control and can stop when not in use.

## Options Considered

### Option A: NAT Gateway (AWS-managed)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — fully managed, no patching |
| Cost | ~$32/mo minimum if left running, plus data processing; not free-tier eligible |
| Scalability | High — scales automatically, AWS-managed HA within an AZ |
| Team familiarity | High — this is the "default" answer most engineers reach for |

**Pros:** zero operational burden, scales transparently, standard/expected pattern.
**Cons:** real, continuous cost with no free tier; easy to leave running by accident and burn the $100 credit budget; overkill for this traffic volume.

### Option B: VPC Endpoints only (no internet egress path)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — one endpoint per AWS service needed, plus route table wiring |
| Cost | Interface endpoints ~$0.01/hr each; several of these approaches NAT Gateway cost |
| Scalability | Fine for this workload |
| Team familiarity | Lower — less commonly reached for by default, worth the practice |

**Pros:** cheapest for pure-AWS traffic, no internet exposure at all for AWS API calls, forces you to actually learn PrivateLink.
**Cons:** doesn't solve the problem — Bedrock (if not using its own endpoint), OpenRouter, and GitHub API are third-party/public endpoints with no VPC endpoint available, so something still needs an internet path.

### Option C: VPC Endpoints for AWS services + single self-managed NAT instance for the rest
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium-high — you own patching/monitoring the NAT instance |
| Cost | Lowest — `t4g.nano` is ~$3/mo, or free-tier eligible depending on instance type/region |
| Scalability | Low — single instance, single point of failure, fine for a demo/portfolio, not for production |
| Team familiarity | Lower — but a genuinely good interview talking point ("I understand what a NAT Gateway abstracts away because I built the cheaper, worse version myself") |

**Pros:** cheapest full solution, and building it teaches you exactly what a NAT Gateway is doing under the hood.
**Cons:** you own its availability; explicitly **not** what you'd do in production at any real scale — must be documented as a deliberate cost trade-off, not presented as a best practice.

## Trade-off Analysis

This is a cost-vs-realism trade-off, not a correctness one. In a production system with real traffic and an SLA, Option A (NAT Gateway) is very likely correct — the operational simplicity is worth $32/month at any real company. For a two-week, self-funded portfolio project, Option C wins on cost and, secondarily, teaches more (you only learn what a managed service does for you by occasionally not using it). The explicit trade-off being made — reduced HA, self-managed patching, single AZ — must be written down in this ADR precisely so it can be defended honestly in an interview: "I chose this to control cost on a personal project; in production I'd use a NAT Gateway or multi-AZ endpoints" is a strong answer, and worth having ready.

## Consequences

- Easier: costs stay near the free-tier/credit budget; forces hands-on PrivateLink and NAT-instance learning.
- Harder: no automatic HA on the egress path; you are responsible for monitoring the NAT instance; must remember to `scripts/teardown.sh` it along with everything else.
- Revisit: if this project ever needed to look "production-ready" for a live demo rather than a portfolio artifact, swap in a real NAT Gateway — note this explicitly in `docs/SCALING.md`.

## Action Items

1. [ ] Terraform: VPC module — S3 Gateway endpoint (free), Interface endpoints for ECR API, ECR DKR, CloudWatch Logs, Secrets Manager (single AZ).
2. [ ] Terraform: single NAT instance (t4g.nano) in the public subnet, security group locked to private subnet CIDRs only, source/dest check disabled.
3. [ ] Route tables: private subnets route 0.0.0.0/0 to the NAT instance ENI.
4. [ ] Document in `scripts/teardown.sh` that the NAT instance must be terminated, not just stopped, to avoid EBS storage charges.
