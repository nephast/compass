# infra/terraform — platform infrastructure

Owns: VPC, EKS cluster, ECR, IAM permission boundaries, AWS Budgets. Changes
rarely, applied manually (never auto-applied — see `.github/workflows/infra-plan.yml`,
which only plans; there is deliberately no `terraform apply` in CI for this repo).

## Structure

- `modules/vpc/` — VPC, subnets, route tables, NAT instance, VPC endpoints (ADR-0001)
- `modules/eks/` — EKS cluster, OIDC provider, node group/Fargate profile (ADR-0003)
- `modules/cloudtrail/` — account-wide CloudTrail trail and its log bucket (ADR-0005)
- `envs/dev/` — dev environment root module, own remote state
- `envs/prod/` — prod environment root module, own remote state (stand this up only once dev is solid — no rush)
- `envs/account/` — account-lifetime resources, own remote state (ADR-0005)

### `envs/account` is not an environment

`envs/dev` and `envs/prod` hold things that exist because an *environment*
exists; they are destroyed by `scripts/teardown.sh` at the end of most sessions
to control cost. `envs/account` holds things that exist because the *AWS account*
exists — currently the CloudTrail trail — and is applied rarely and destroyed
essentially never.

The split is by **state file**, not just by module, and that is the substantive
part: Terraform's unit of destruction is the state file, so separate state is
the only thing that structurally prevents `terraform destroy` in `envs/dev` from
taking the audit trail with it. A trail defined in `envs/dev` would be deleted
on a schedule, silently. See ADR-0005.

## State

Use an S3 backend with native state locking (`use_lockfile = true`, Terraform
>= 1.11) — **no DynamoDB lock table**. Bootstrap the bucket manually, once,
before anything else: it can't be created by the Terraform that will store its
state in it. Steps: `docs/runbooks/terraform-bootstrap.md`.

`envs/*/backend.tf` is gitignored so the real bucket name stays out of this
public repo; `backend.tf.example` is the committed shape. That has a
consequence for CI: **a workflow running `terraform init` gets no backend
block**, silently falls back to a local backend, and plans against empty state —
producing a confident "everything will be created" diff for infrastructure that
already exists. Any CI job that plans must pass the config explicitly:

```bash
terraform init \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=dev/terraform.tfstate" \
  -backend-config="region=${AWS_REGION}" \
  -backend-config="use_lockfile=true"
```

with `TF_STATE_BUCKET` as a GitHub repository variable. Do this in the PR that
flips `terraform-plan` off `if: false` in `.github/workflows/infra-plan.yml`.

Note there is now more than one root, each with its own key (`dev/terraform.tfstate`,
`account/terraform.tfstate`). The plan job must iterate over them — a job hardcoded
to `dev` leaves `envs/account` unplanned and free to drift.

## TODO

- [x] Bootstrap S3 state bucket (COMPASS-5, one-time, manual — done; no lock table, native S3 locking)
- [ ] `modules/vpc/` — see ADR-0001 for exactly what to build
- [ ] `modules/eks/` — see ADR-0003
- [ ] `envs/dev/main.tf` — wire the modules together, write outputs to SSM Parameter Store for CDK to read
- [ ] IAM permission boundary policy (COMPASS-8), applied to every role this creates
- [ ] AWS Budgets resource (COMPASS-2) — codify the budget you set up manually in Epic 0, so it survives an account rebuild
- [x] `modules/cloudtrail/` + `envs/account/` — CloudTrail in IaC after the console-created trail was deleted as apparent drift (COMPASS-1, ADR-0005)
