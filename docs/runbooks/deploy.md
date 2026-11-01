# Runbook: deploy (COMPASS-35)

Written for someone who did not build Compass. Two parts: **first bring-up** of an
empty account (once), then **everyday deploys** (automatic).

Placeholders: `<account>` is your 12-digit account id, `<region>` is `eu-west-1`.
Never paste real values into this repo — it is public.

## Before anything: cost

The EKS control plane bills **$0.10/hour from the moment it exists**, and the full
stack costs about **$5/day** running (`docs/SCALING.md`, "Cost at scale"). Check AWS
Budgets first; end every session with `docs/runbooks/teardown.md`.

## Part 1 — first bring-up (order matters)

Each layer reads what the previous one published to SSM Parameter Store.

| # | Step | Command / where | Takes |
|---|---|---|---|
| 1 | Budgets alarms | `scripts/setup-aws-guardrails.sh you@example.com` | 1 min |
| 2 | Terraform state bucket | `docs/runbooks/terraform-bootstrap.md` | 2 min |
| 3 | **Account layer**: CloudTrail, permissions boundary, CI roles | `cd infra/terraform/envs/account && terraform apply` with `terraform.tfvars`: `state_bucket = "..."`, `alert_email = "..."` | 2 min |
| 4 | Bedrock model access | console → Bedrock → Model access: Titan Text Embeddings V2, Nova Lite (Amazon models need no form) | 2 min |
| 5 | **Platform layer**: VPC, RDS, ECR, EKS, ALB | `cd infra/terraform/envs/dev && terraform apply` with `terraform.tfvars`: `eks_public_access_cidrs = ["<your ip>/32"]`, `ci_deploy_role_arn = "<step 3 output>"` | **~20 min** (EKS) |
| 6 | Database bootstrap (roles, pgvector) | `docs/runbooks/database-bootstrap.md` steps 1–3, then `npm run migrate` per `apps/db/README.md` | 15 min |
| 7 | CDK bootstrap, **both regions** (WAF lives in us-east-1) | `npx cdk bootstrap aws://<account>/eu-west-1 aws://<account>/us-east-1` | 3 min |
| 8 | First images | `aws ecr get-login-password \| docker login …` then `docker build -f apps/api/Dockerfile -t <registry>/compass-api:$(git rev-parse HEAD) . && docker push …` (and agent-tools) | 5 min |
| 9 | **Application layer** | `npm run build -w @compass/frontend && cd infra/cdk && npx cdk deploy --all --context env=dev --context alertEmail=you@example.com` | ~15 min (CloudFront) |
| 10 | Pods | `scripts/k8s-deploy.sh dev $(git rev-parse HEAD)` | 2 min |
| 11 | Confirm the SNS email subscriptions | your inbox (two: alarms, CloudTrail tamper) | — |
| 12 | Smoke-test user (below) | — | 2 min |
| 13 | `scripts/smoke-test.sh dev` | must end with `Smoke test passed for dev.` | 1–2 min |

### Smoke-test user (once)

```bash
POOL=$(aws ssm get-parameter --name /compass/dev/app/cognito_user_pool_id --query Parameter.Value --output text)
PASS="$(openssl rand -base64 24)Aa1"
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username smoke@compass.invalid \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username smoke@compass.invalid \
  --password "$PASS" --permanent
aws secretsmanager create-secret --name compass/dev/smoke-test-user \
  --secret-string "{\"username\":\"smoke@compass.invalid\",\"password\":\"$PASS\"}"
```

### Optional: OpenRouter or a GitHub token for the agent

```bash
aws secretsmanager put-secret-value --secret-id compass/dev/agent \
  --secret-string '{"OPENROUTER_API_KEY":"...","GITHUB_TOKEN":"..."}'
kubectl -n compass rollout restart deployment/agent-tools   # secrets are read at boot
```

### Turn on CI deploys

GitHub → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| secret | `AWS_CI_ROLE_ARN` | `ci_deploy_role_arn` output (step 3) |
| secret | `AWS_CI_PLAN_ROLE_ARN` | `ci_plan_role_arn` output |
| secret | `TF_STATE_BUCKET` | the state bucket name |
| variable | `AWS_REGION` | `eu-west-1` |
| variable | `AWS_CI_ENABLED` | `true` |

Settings → Environments: create `dev` (no reviewers) and `prod` (**required
reviewers: you**). Settings → Actions → General: enable **Require actions to be
pinned to a full-length commit SHA** (#59).

## Part 2 — everyday deploys

Merge to `main`. `deploy-dev.yml` then, unattended:

1. builds both images, tags them with the commit SHA, pushes to (immutable) ECR;
2. builds the frontend and runs `cdk deploy --all` (the Site stack invalidates CloudFront);
3. `scripts/k8s-deploy.sh dev <sha>` and waits for both rollouts;
4. `scripts/smoke-test.sh dev`, and **on failure rolls the Deployments back** (`rollback.md`).

Watch it under Actions → Deploy to dev. A green run means the smoke test's RAG query
cited the seeded document through the real edge.

### Promote to prod

Actions → Promote to prod → Run workflow → paste the **full SHA** dev ran → a
reviewer approves the `prod` environment. Nothing is rebuilt. (No prod environment
exists yet: it would need a second set of Terraform/CDK at `env=prod`, and
`vars.PROD_ENABLED=true`.)

## Verify by hand

```bash
API=$(aws ssm get-parameter --name /compass/dev/app/api_url --query Parameter.Value --output text)
curl -s "$API/healthz"                                  # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" "$API/documents"   # 401
aws eks update-kubeconfig --name compass-dev && kubectl -n compass get pods,hpa
```
