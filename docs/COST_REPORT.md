# Cost report (COMPASS-37)

**Status: the template and the tooling are done. The actual figures can only come
from the account's Cost Explorer, so they still need filling in.** Generate them with:

```bash
scripts/cost-report.sh 2026-08-24 2026-11-08 > /tmp/cost.md   # end date is exclusive
```

Before the run that counts, activate **`Project`** and **`Environment`** as cost
allocation tags (Billing → Cost allocation tags). Every Terraform resource is tagged
through `default_tags`, and every CDK resource through `Tags.of(app)`. Tags only
attribute usage from *after* activation.

## Actuals

*(Paste the script's output here: whole account by service, tagged-only by
service, credits applied.)*

| Service | USD |
|---|---:|
| | |

Credit remaining at the end: $___ of $100 (the free-plan balance noted in #53 was $159.81).

## Expected profile (for checking the actuals against)

Hourly list prices, eu-west-1, while the full stack is up:

| Line item | $/hour | $/day up | Notes |
|---|---:|---:|---|
| EKS control plane | 0.100 | 2.40 | bills from creation, regardless of nodes |
| 2 × `t3.small` nodes | 0.042 | 1.00 | |
| Internal ALB | 0.025 | 0.60 | + LCU, negligible here |
| `db.t3.micro` + 20 GiB gp3 | 0.023 | 0.56 | ~$17/month; **not** free on the credit-based free plan (#53) |
| NAT instance `t3.micro` | 0.011 | 0.27 | also not free on the credit-based plan |
| WAF | — | 0.27 | $8/month prorated, + $0.60 per million requests |
| KMS (EKS secrets key) | — | 0.03 | $1/month |
| Secrets Manager (2 secrets) | — | 0.03 | |
| CloudWatch, Lambda, Step Functions, S3, CloudFront, API Gateway, Bedrock | — | < 0.25 | usage-driven; tiny at demo volume |
| **Total** | **~0.20** | **~5.40** | |

So the bill is roughly **$5.40 × days-the-stack-was-up** plus a few cents of
usage. If the actuals are much higher, the likely culprits, in order:

1. A cluster left up overnight or over a weekend (EKS + nodes ≈ $3.40/day).
2. Interface endpoints switched on (`enable_interface_endpoints`, ~$2.10/day).
3. EKS in **extended support**: a cluster on an old Kubernetes version bills
   $0.60/hour, six times standard.
4. CloudWatch Logs ingestion if log levels or retention were changed.

## What this says about cloud cost (the interview answer)

- **Fixed costs dominate a small system.** About 90% of the bill is things that
  bill per hour whether or not anyone uses them (control plane, nodes, ALB,
  database). The per-request cost of an actual RAG query is a fraction of a cent.
- **So the lever is time-up, not efficiency.** Teardown discipline
  (`scripts/teardown.sh`, verified by `scripts/verify-teardown.sh`) saved more than
  any tuning could have.
- **Tag at creation, activate early.** Untagged spend can't be attributed after the fact.
- **"Free tier" changed in July 2025.** On the credit-based plan, `t3.micro` and
  `db.t3.micro` bill against the credit (#53). Assumptions written before that are wrong.
