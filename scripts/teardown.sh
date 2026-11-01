#!/usr/bin/env bash
# COMPASS-38: tear down every billable resource this project created. Run at
# the end of every session that doesn't need things running overnight.
# Idempotent: safe to re-run. Walkthrough: docs/runbooks/teardown.md.
#
# Order matters: CDK first (its Lambda and VPC Link network interfaces sit in
# Terraform's subnets), then wait for those interfaces to be released, then
# Terraform. envs/account is NEVER touched (ADR-0005).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV="${1:-dev}"
REGION="${AWS_REGION:-eu-west-1}"

echo "=== Compass teardown: $ENV ($REGION) ==="
read -r -p "Type 'teardown' to confirm: " CONFIRM
[ "$CONFIRM" = "teardown" ] || { echo "Aborted."; exit 1; }

VPC_ID=$(aws ssm get-parameter --region "$REGION" --name "/compass/$ENV/network/vpc_id" \
  --query Parameter.Value --output text 2>/dev/null || echo "")

echo "--- 1/4 CDK: destroying application stacks (both regions) ---"
if (cd infra/cdk && npx cdk destroy --all --force --context env="$ENV" --no-notices); then
  echo "CDK stacks destroyed."
else
  echo "CDK destroy reported a failure -- continuing; check CloudFormation afterwards."
fi

echo "--- 2/4 Waiting for Lambda / VPC Link network interfaces to be released ---"
if [ -n "$VPC_ID" ] && [ "$VPC_ID" != "None" ]; then
  for attempt in $(seq 1 40); do
    total=$(aws ec2 describe-network-interfaces --region "$REGION" \
      --filters "Name=vpc-id,Values=$VPC_ID" \
      --query "length(NetworkInterfaces[?starts_with(Description, 'AWS Lambda VPC ENI') || contains(Description, 'VPC Link')])" \
      --output text 2>/dev/null || echo 0)
    [ "$total" = "0" ] && { echo "No managed interfaces left in $VPC_ID."; break; }
    echo "  $total interface(s) still attached (attempt $attempt/40, checking every 30s)"
    sleep 30
  done
fi

echo "--- 3/4 Terraform: destroying platform ($ENV) ---"
if [ -f "infra/terraform/envs/$ENV/backend.tf" ]; then
  (cd "infra/terraform/envs/$ENV" && terraform destroy -auto-approve) || {
    echo "Terraform destroy failed. If the error is DependencyViolation, wait 10 minutes and re-run."
    exit 1
  }
else
  echo "No infra/terraform/envs/$ENV/backend.tf -- skipping (nothing applied from this machine?)."
fi

echo "--- 4/4 Verifying nothing billable survives ---"
scripts/verify-teardown.sh "$REGION"

echo
echo "envs/account (CloudTrail, permissions boundary, CI roles) was deliberately kept."
echo "Log this teardown in docs/runbooks/teardown.md's session log."
