# infra/terraform — platform infrastructure

Owns: VPC, EKS cluster, ECR, IAM permission boundaries, AWS Budgets. Changes
rarely, applied manually (never auto-applied — see `.github/workflows/infra-plan.yml`,
which only plans; there is deliberately no `terraform apply` in CI for this repo).

## Structure

- `modules/vpc/` — VPC, subnets, route tables, NAT instance, VPC endpoints (ADR-0001)
- `modules/eks/` — EKS cluster, OIDC provider, node group/Fargate profile (ADR-0003)
- `envs/dev/` — dev environment root module, own remote state
- `envs/prod/` — prod environment root module, own remote state (stand this up only once dev is solid — no rush)

## State

Use an S3 backend + DynamoDB lock table (bootstrap these two resources manually,
once, before anything else — they can't be created by the Terraform they'll
store state for). Document the bootstrap steps in `docs/runbooks/terraform-bootstrap.md`
once you've done it for real.

## TODO

- [ ] Bootstrap S3 state bucket + DynamoDB lock table (COMPASS-5, one-time, manual)
- [ ] `modules/vpc/` — see ADR-0001 for exactly what to build
- [ ] `modules/eks/` — see ADR-0003
- [ ] `envs/dev/main.tf` — wire the modules together, write outputs to SSM Parameter Store for CDK to read
- [ ] IAM permission boundary policy (COMPASS-8), applied to every role this creates
- [ ] AWS Budgets resource (COMPASS-2) — codify the budget you set up manually in Epic 0, so it survives an account rebuild
