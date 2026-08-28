#!/usr/bin/env bash
# COMPASS-38: Tear down every billable resource this project created. Run at
# the end of every session where you don't need things running overnight,
# and definitely at the end of the two weeks. Idempotent — safe to re-run.
#
# This script destroys IaC-managed resources via Terraform/CDK; anything
# created manually (e.g. during Epic 0 experimentation) needs a manual check
# in the console too — the script prints a reminder at the end.

set -euo pipefail

echo "=== Compass teardown ==="
echo "This will destroy dev (and prod, if it exists) infrastructure."
read -p "Type 'teardown' to confirm: " CONFIRM
if [ "$CONFIRM" != "teardown" ]; then
  echo "Aborted."
  exit 1
fi

echo "--- CDK: destroying app-infra stacks ---"
if [ -d infra/cdk ]; then
  (cd infra/cdk && npx cdk destroy --all --force --context env=dev) || \
    echo "CDK destroy failed or nothing to destroy — check manually."
fi

# NB: envs/account is deliberately NOT destroyed. It holds account-lifetime
# resources — the CloudTrail trail and its log bucket — in a separate state
# file, so `terraform destroy` here cannot reach them. That separation is the
# point: an audit log deleted at the end of every session is not an audit log.
# See ADR-0005.
echo "--- Terraform: destroying platform infra (dev) ---"
if [ -d infra/terraform/envs/dev ] && [ -f infra/terraform/envs/dev/backend.tf ]; then
  (cd infra/terraform/envs/dev && terraform destroy -auto-approve) || \
    echo "Terraform destroy failed or nothing to destroy — check manually."
fi

echo ""
echo "=== Manual verification checklist (do this even if the above succeeded) ==="
echo "  [ ] EKS console — no clusters listed (control plane bills independently of nodes)"
echo "  [ ] EC2 console — NAT instance terminated, not just stopped (stopped still bills EBS)"
echo "  [ ] RDS console — no instances listed"
echo "  [ ] VPC console — Interface endpoints removed (they bill hourly even idle)"
echo "  [ ] ECR — old image versions cleaned up if storage cost matters to you"
echo "  [ ] CloudFront/S3 — fine to leave, effectively free at this scale"
echo "  [ ] AWS Budgets dashboard — confirm spend has stopped climbing"
echo "  [ ] CloudTrail — the trail SHOULD still be there. If it is missing,"
echo "      re-apply infra/terraform/envs/account (ADR-0005)."
echo ""
echo "Log what you tore down and when in docs/runbooks/teardown.md's session log."
