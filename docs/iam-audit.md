# IAM least-privilege audit (COMPASS-33)

**As of:** 2026-11-01, against `main` plus this branch. Re-run whenever a role is
added: the CDK assertion test (`infra/cdk/test/stacks.test.ts`) already fails if a
role in any stack lacks the permissions boundary.

## Method

1. Enumerate every role: `grep -rn "aws_iam_role\b" infra/terraform` and every
   `AWS::IAM::Role` in `cdk synth` output.
2. For each: who can assume it (trust), what it can do (policies), and whether any
   `*` is laziness or an AWS limitation.
3. Every role must carry `compass-permissions-boundary` (COMPASS-8).

## Roles

| Role | Created by | Trusted principal | Permissions | Wildcards | Verdict |
|---|---|---|---|---|---|
| `compass-ci-plan` | TF account | GitHub OIDC, `pull_request` in this repo only | `ReadOnlyAccess`; state lock objects; CDK lookup role | `ReadOnlyAccess` is broad **read** | Exception 1 |
| `compass-ci-deploy` | TF account | GitHub OIDC, `main` / `environment:dev\|prod` | assume `cdk-*` bootstrap roles; ECR push to `compass-*`; `eks:DescribeCluster` on `compass-*`; SSM `/compass/*`; smoke-test secret; `cognito-idp:AdminInitiateAuth` | `ecr:GetAuthorizationToken` on `*` (AWS: no resource-level support); user pool ARN `*` (pool id unknown to account layer) | OK, exception 2 |
| `compass-dev-eks-cluster` | TF dev | `eks.amazonaws.com` | `AmazonEKSClusterPolicy` (AWS managed) | managed policy | OK — required by EKS |
| `compass-dev-eks-node` | TF dev | `ec2.amazonaws.com` | `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy`, `AmazonEC2ContainerRegistryReadOnly` | managed | Exception 3 |
| `compass-dev-cloudwatch-agent` | TF dev | IRSA: `amazon-cloudwatch:cloudwatch-agent` only | `CloudWatchAgentServerPolicy` | managed | OK |
| `compass-dev-api` | CDK Api | IRSA: `compass:api` only | `s3:PutObject` on `<bucket>/uploads/*`; `rds-db:connect` as `compass_app`; Bedrock invoke on Titan V2 + Nova/Claude profiles | none on actions; foundation-model region `*` (inference profiles route cross-region) | OK |
| `compass-dev-agent-tools` | CDK Api | IRSA: `compass:agent-tools` only | `ce:GetCostAndUsage`, `cloudwatch:DescribeAlarms`; read **one** secret; Bedrock completions | `ce` and `DescribeAlarms` on `*` | Exception 4 |
| Ingest Lambda role | CDK Ingestion | `lambda.amazonaws.com` | `s3:GetObject*` on `<bucket>/uploads/*` (plus `List`/`GetBucket*` on the bucket, from `grantRead`); `rds-db:connect` as `compass_app`; Bedrock Titan V2; VPC ENI management (AWS managed); X-Ray write | ENI actions on `*` (AWS: required by Lambda-in-VPC) | OK |
| Step Functions role | CDK Ingestion | `states.amazonaws.com` | `lambda:InvokeFunction` on the ingest function; X-Ray; log delivery | log-delivery actions on `*` (AWS: no resource-level support) | OK |
| EventBridge → Step Functions role | CDK Ingestion | `events.amazonaws.com` | `states:StartExecution` on the one state machine | none | OK |
| CDK custom-resource roles (bucket auto-delete, BucketDeployment, WAF-ARN reader) | CDK | `lambda.amazonaws.com` | scoped to their bucket / distribution / one SSM parameter | CloudFront invalidation on `*` (AWS: no resource-level support for `CreateInvalidation` until recently) | OK — bounded by the boundary aspect |
| `db_connect` / `db_migrate` policies | TF dev | (attached to the above) | `rds-db:connect` as one database user each | instance segment `*` (#52) | Exception 5 |

## Documented exceptions

1. **CI plan role has `ReadOnlyAccess`.** `terraform plan` and `cdk diff` must read
   every resource type the code declares, and the list changes with the code. A
   hand-curated read list would break each time a resource type is added. It can't
   write, and it can only be assumed from a PR in this repository.
2. **`ecr:GetAuthorizationToken` on `*`** — the action has no resource-level scoping.
   The token only lets CI push where the separate `EcrPush` statement allows (`compass-*`).
3. **CNI policy on the node role, not its own IRSA role.** The `aws-node` DaemonSet is
   the only consumer; pods cannot reach the node role (IMDS hop limit 1). Moving it to
   IRSA is the textbook fix and a small change; not done because it adds a role for no
   reachable attack.
4. **`ce:GetCostAndUsage` and `cloudwatch:DescribeAlarms` on `*`** — neither supports
   resource-level permissions. Both are read-only (ADR-0008).
5. **`rds-db:connect` on `dbuser:*/compass_app`** — the instance segment was a
   resource id, which made the policy depend on the instance and blocked teardown
   (#52). Scope is still one database *user*. The database's own `GRANT`s decide what
   that user can touch, and only the app security group can reach port 5432.

## Not roles, but checked

- **Permissions boundary** (`modules/permission-boundary`): a broad Allow ceiling with
  explicit Denies on: attaching `AdministratorAccess` / `IAMFullAccess` /
  `PowerUserAccess`; creating a role without this boundary; editing policies of
  unbounded roles; removing or editing the boundary itself; creating users or access
  keys; stopping or deleting CloudTrail.
- **No IAM users or access keys are created by any IaC in this repo.**
- **Human access** is outside IaC. The Aug 2026 trail deletion was done with a
  long-lived key without MFA (#55): deactivate long-lived keys for daily work and use
  SSO / `aws login` sessions. The CloudTrail tamper alert now catches a repeat within minutes.

## Acceptance test for the boundary (COMPASS-8)

```bash
# As any bounded role, e.g. the CI deploy role (assume it with the AWS CLI):
aws iam attach-role-policy --role-name compass-dev-api \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
# -> AccessDenied ... with an explicit deny in a permissions boundary
```
