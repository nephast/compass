#!/usr/bin/env bash
# COMPASS-38: lists anything still billing after a teardown, through the API
# rather than trusting the teardown's exit code. Exits non-zero if anything
# billable is found. Read-only.
#
#   scripts/verify-teardown.sh [region]
set -uo pipefail
REGION="${1:-${AWS_REGION:-eu-west-1}}"
found=0

check() {
  local label="$1" count="$2" detail="${3:-}"
  if [ "${count:-0}" != "0" ] && [ -n "${count:-}" ]; then
    echo "  [BILLING] $label: $count $detail"
    found=1
  else
    echo "  [ok]      $label"
  fi
}

echo "Billable resources in $REGION (and us-east-1 for edge services):"
check "EKS clusters" "$(aws eks list-clusters --region "$REGION" --query 'length(clusters)' --output text)"
check "running/stopped EC2 instances" "$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'length(Reservations[].Instances[])' --output text)" "(stopped instances still bill EBS)"
check "RDS instances" "$(aws rds describe-db-instances --region "$REGION" --query 'length(DBInstances)' --output text)"
check "load balancers" "$(aws elbv2 describe-load-balancers --region "$REGION" --query 'length(LoadBalancers)' --output text)"
check "NAT gateways" "$(aws ec2 describe-nat-gateways --region "$REGION" \
  --filter Name=state,Values=pending,available --query 'length(NatGateways)' --output text)"
check "interface VPC endpoints" "$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --filters Name=vpc-endpoint-type,Values=Interface --query 'length(VpcEndpoints)' --output text)"
check "unattached Elastic IPs" "$(aws ec2 describe-addresses --region "$REGION" \
  --query 'length(Addresses[?AssociationId==null])' --output text)"
check "EBS volumes" "$(aws ec2 describe-volumes --region "$REGION" --query 'length(Volumes)' --output text)"
check "CloudFront distributions" "$(aws cloudfront list-distributions \
  --query 'length(DistributionList.Items || `[]`)' --output text)"
check "WAF web ACLs (CloudFront scope)" "$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 \
  --query 'length(WebACLs)' --output text)"
check "Compass Secrets Manager secrets" "$(aws secretsmanager list-secrets --region "$REGION" \
  --filters Key=name,Values=compass/ --query 'length(SecretList)' --output text)" "(\$0.40/month each)"

echo
trail=$(aws cloudtrail describe-trails --region "$REGION" --query 'length(trailList)' --output text)
echo "CloudTrail trails (should be >= 1, it is kept on purpose): $trail"

if [ "$found" = "1" ]; then
  echo "Something is still billing. See docs/runbooks/teardown.md, 'If something is stuck'."
  exit 1
fi
echo "Nothing billable found."
