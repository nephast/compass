# infra/cdk — application infrastructure

Owns S3, CloudFront, WAF, API Gateway, Lambda, Step Functions, EventBridge,
Cognito, the pods' IRSA roles, dashboards and alarms. Terraform owns the platform
(VPC, EKS, RDS, ECR, ALB, the permissions boundary) and publishes it to SSM; CDK
reads it back at **deploy** time (`lib/seam.ts`), so `cdk synth` needs no AWS
credentials and nothing account-specific lands in `cdk.context.json`.

## Stacks (`--context env=dev`)

| Stack | Region | What | Ticket |
|---|---|---|---|
| `Compass-dev-EdgeWaf` | us-east-1 | WAF web ACL: per-IP rate limit + AWS managed rules; ARN → SSM | COMPASS-32 |
| `Compass-dev-Frontend` | eu-west-1 | private S3 + CloudFront (OAC), security headers, WAF attached | COMPASS-24 |
| `Compass-dev-Auth` | eu-west-1 | Cognito pool, PKCE web client (15-min tokens), smoke-test client | COMPASS-15 |
| `Compass-dev-Ingestion` | eu-west-1 | documents bucket → EventBridge → Step Functions → ingest Lambda (VPC, IAM DB auth) | COMPASS-9–12 |
| `Compass-dev-Api` | eu-west-1 | HTTP API + JWT authorizer + VPC Link → internal ALB; IRSA roles; agent secret | COMPASS-16, 18 |
| `Compass-dev-Site` | eu-west-1 | static export + `config.json`, CloudFront invalidation in the same deploy | COMPASS-24 |
| `Compass-dev-Observability` | eu-west-1 | dashboard + 4 alarms → SNS | COMPASS-29, 30 |

## Deploy

Prerequisites: `infra/terraform/envs/account` and `envs/dev` applied (they write the
SSM parameters), and CDK bootstrapped in **both** regions:

```bash
npx cdk bootstrap aws://<account>/eu-west-1 aws://<account>/us-east-1
```

```bash
npm run build -w @compass/frontend      # optional: without it the Site stack deploys a placeholder page
npx cdk deploy --all --context env=dev --context alertEmail=you@example.com
```

## Guarantees the tests check (`npm test -w @compass/cdk`)

- Every IAM role in every stack carries `compass-permissions-boundary` — including
  CDK's own custom-resource roles, which the built-in mechanism misses
  (`lib/boundary.ts`), and with no `crossRegionReferences` (its writer role could
  never be bounded).
- No template contains a literal account id.
- Frontend bucket is fully private; one OAC; WAF attached; deploy invalidates `/*`.
- Every API route except `GET /healthz` requires the JWT authorizer; the stage is throttled.
- Each IRSA role trusts exactly one service account.
- The four alarms exist.
