# infra/cdk — application infrastructure

Owns: S3 (docs bucket + frontend hosting), CloudFront, API Gateway, Lambda
(ingestion), Step Functions, EventBridge, Cognito, SQS/DLQ. See ADR (in
`docs/ARCHITECTURE.md`) for why this is split from `infra/terraform`.

Reads the VPC ID, subnet IDs, and EKS OIDC provider ARN that Terraform created
from **SSM Parameter Store** (not hardcoded, not passed via `.env`) — Terraform
writes them, CDK reads them. This is the cross-stack seam; get it working early
(COMPASS-5/6 write the parameters, COMPASS-9+ reads them).

## TODO

- [ ] `cdk init app --language typescript` in this directory
- [ ] `bin/compass.ts` — entry point, one stack set per environment (`dev`, `prod`) via CDK context (`--context env=dev`)
- [ ] `lib/ingestion-stack.ts` — S3, EventBridge, Step Functions, SQS/DLQ, Lambdas (COMPASS-9–12)
- [ ] `lib/data-stack.ts` — if RDS ends up here instead of Terraform, document that choice; default assumption is Terraform owns it (ADR-0002)
- [ ] `lib/auth-stack.ts` — Cognito User Pool + client (COMPASS-15)
- [ ] `lib/api-stack.ts` — API Gateway HTTP API + JWT authorizer + VPC Link into EKS (COMPASS-16)
- [ ] `lib/frontend-stack.ts` — S3 + CloudFront with Origin Access Control, cache invalidation output for CI to use (COMPASS-24)
- [ ] Every stack: tag all resources (`Project=compass`, `Environment=<env>`) for cost allocation reporting (COMPASS-37)
