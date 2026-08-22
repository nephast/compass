# Runbook: Terraform state backend bootstrap (one-time, manual)

Terraform can't create the S3 bucket + DynamoDB table it will store its own
state in — that has to exist first, created once, outside of Terraform (or in
a separate, tiny Terraform config with local state, if you want it IaC'd too).

```bash
aws s3api create-bucket \
  --bucket compass-tfstate-<your-unique-suffix> \
  --region <region> \
  --create-bucket-configuration LocationConstraint=<region>

aws s3api put-bucket-versioning \
  --bucket compass-tfstate-<your-unique-suffix> \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket compass-tfstate-<your-unique-suffix> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws dynamodb create-table \
  --table-name compass-tfstate-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Then rename `infra/terraform/envs/dev/backend.tf.example` to `backend.tf`,
fill in your real bucket name, and run `terraform init`.
