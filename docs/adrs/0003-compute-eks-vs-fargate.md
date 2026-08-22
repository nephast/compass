# ADR-0003: Compute Platform for the API/Agent Service — EKS vs ECS Fargate

**Status:** Accepted
**Date:** 2026-08-22
**Deciders:** Stéphan (solo project)

## Context

The `api` and `agent-tools` services are long-running, synchronous-ish workloads (an interactive agent loop that may call multiple tools per request) that need to run somewhere other than Lambda. The two realistic AWS options are ECS on Fargate and EKS. Day-to-day work is serverless-first (Lambda/API Gateway/DynamoDB/EventBridge) — containers and Kubernetes are explicitly the skill gap this project is meant to close, specifically "containers, k8s, networking and security at scale." Budget: a new AWS account, free tier, plus $100 of credit for two weeks, with an explicit willingness to spend that credit on this rather than conserve it. The EKS control plane costs ~$0.10/hr (~$73/mo) regardless of usage the moment it exists — this is the single largest fixed cost in the entire project.

## Decision

Run the `api` and `agent-tools` services on **EKS**, accepting the control-plane cost, guarded by AWS Budgets alerts at $10/$25/$50/$90 of the credit and a mandatory teardown at the end of the two weeks (or a documented scale-to-near-zero if kept longer). This is the deliberately harder, more expensive option, chosen specifically because the stated goal is depth on Kubernetes-on-AWS, not cost minimization on this particular layer (cost is minimized elsewhere instead — see ADR-0001, ADR-0002).

## Options Considered

### Option A: ECS on Fargate
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low-medium — no control plane to reason about, task definitions are simpler than K8s manifests |
| Cost | No fixed floor — pay only for running tasks; cheaper for an intermittently-used portfolio project |
| Scalability | Good — Service Auto Scaling, straightforward |
| Team familiarity | New-ish (AWS-specific), but conceptually closer to Docker Compose |

**Pros:** cheapest, fastest to get running, less to secure/patch, AWS-native and low-ceremony.
**Cons:** doesn't teach Kubernetes at all — the explicit stated goal here — and "Fargate experience" is a narrower, more AWS-specific skill than "Kubernetes experience," which is portable across clouds and highly sought after in interviews.

### Option B: EKS (Kubernetes)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High — control plane, node groups (or Fargate profiles for pods), IRSA/OIDC, networking (CNI, network policies), ingress controller, all self-configured |
| Cost | ~$73/mo control plane floor alone, before nodes; real budget risk if left running |
| Scalability | Excellent, and the patterns (HPA, cluster autoscaler, PodDisruptionBudgets) transfer to any cloud or on-prem K8s |
| Team familiarity | Explicitly the gap being closed |

**Pros:** deepest, most transferable learning (IRSA, HPA, network policies, RBAC, ingress — all directly interview-relevant, and portable beyond AWS); demonstrates you can run K8s on a cloud, not just describe it.
**Cons:** real, continuous cost that must be actively managed; most likely place to accidentally overspend the $100 credit if `scripts/teardown.sh` isn't run diligently; steepest learning curve of any component in this project.

## Trade-off Analysis

Normally the honest engineering answer for a workload this size is Fargate — lower cost, lower operational burden, same runtime capability. That's precisely why it's rejected here: this project's purpose is learning, not shipping the cheapest correct system, and the areas where "cheapest correct" and "most educational" diverge are exactly the areas worth spending the budget on deliberately. EKS is chosen with eyes open about the cost, mitigated by hard budget alarms and a non-negotiable teardown habit rather than by avoiding the service. This ADR should be read alongside ADR-0001 (NAT cost) and ADR-0002 (vector store cost) — the budget is being spent where it teaches the most, and saved everywhere else.

## Consequences

- Easier: nothing — this is explicitly the higher-effort choice, taken on purpose.
- Harder: real cost-management discipline is now required; every session should start by checking the AWS Budgets dashboard and end with a decision to leave the cluster up or tear it down; node group sizing needs to be genuinely minimal (a single small managed node group, or Fargate profiles for the pods themselves to skip node management entirely — decide during Epic 1).
- Revisit: if the credit runs low before the two weeks are up, switch the remaining work to a scaled-to-zero cluster (0 nodes, control plane paused isn't possible on EKS — so this may mean deleting and recreating the cluster between sessions once the manifests are stable, which is itself a useful exercise in "can I stand this back up from IaC alone").

## Action Items

1. [ ] Terraform: EKS cluster, decide node groups vs Fargate profiles for pods during Epic 1 (document the sub-decision in this ADR's follow-up notes).
2. [ ] IRSA: OIDC provider + scoped IAM roles per service account, no wildcard pod permissions.
3. [ ] AWS Budgets: $10/$25/$50/$90 thresholds against the $100 credit, SNS → email.
4. [ ] `scripts/teardown.sh` must fully delete the EKS cluster (not just scale nodes to 0) — verify this explicitly, since the control plane bills independently of node count.
5. [ ] Start-of-session checklist item: check AWS Budgets before doing any new work (see `docs/PROGRAM.md` Epic 0).
