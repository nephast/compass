# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-nat-gateway-vs-vpc-endpoints.md) | Outbound connectivity — NAT Gateway vs VPC endpoints | Accepted |
| [0002](0002-vector-store-choice.md) | Vector store — pgvector on RDS vs OpenSearch | Accepted |
| [0003](0003-compute-eks-vs-fargate.md) | Compute platform — EKS vs ECS Fargate | Accepted |
| [0004](0004-rds-iam-auth.md) | Database authentication — IAM auth vs password in Secrets Manager | Accepted |
| [0005](0005-cloudtrail-in-account-scoped-state.md) | CloudTrail lives in account-scoped Terraform state | Accepted |

Write a new ADR (copy [`0000-template.md`](0000-template.md)) whenever you make a decision you'd need to defend in an interview — not just the big ones. "Why Fastify over Express," "why conventional commits," "why single-region" are all fair game if you had to actually weigh options. Interviewers care more about *how* you decided than *what* you decided.
