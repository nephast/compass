# Runbook: Terraform state backend bootstrap (one-time, manual)

Terraform can't create the S3 bucket it stores its own state in — that has to
exist first, created once, outside of Terraform (or in a separate, tiny
Terraform config with local state, if you want it IaC'd too).

**No DynamoDB lock table is needed.** Terraform >= 1.11 locks state with S3
conditional writes (`use_lockfile = true` in the backend block), which replaces
the old DynamoDB lock table. Do not create one.

```bash
BUCKET=compass-tfstate-<your-unique-suffix>   # must be globally unique
REGION=<region>

aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

# Versioning is the undo button for the whole project: every apply overwrites
# state, and a corrupted or deleted state file can only be rolled back if the
# bucket keeps old versions.
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Then copy `infra/terraform/envs/dev/backend.tf.example` to `backend.tf`, fill in
your real bucket name, and run `terraform init`.

`backend.tf` is gitignored on purpose — this repo is public and the real bucket
name stays out of it. Consequence: **CI has no backend config**, so any workflow
running `terraform init` must pass one explicitly (see `infra/terraform/README.md`),
or it will silently fall back to a local backend and plan against empty state.
