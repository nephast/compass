#!/usr/bin/env bash
# COMPASS-2: Set up AWS Budgets alerts against your $100 credit before you
# deploy anything. Run this once, locally, with your AWS CLI already
# configured (aws configure / SSO login) — it does NOT run in CI on purpose,
# budget setup is a one-time, human-reviewed action.
#
# Usage: ./scripts/setup-aws-guardrails.sh you@example.com

set -euo pipefail

EMAIL="${1:?Usage: $0 <notification-email>}"
BUDGET_NAME="compass-credit-budget"
BUDGET_LIMIT="100"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "Account: $ACCOUNT_ID"
echo "Creating budget '$BUDGET_NAME' for \$$BUDGET_LIMIT with alerts to $EMAIL ..."

cat > /tmp/compass-budget.json <<EOF
{
  "BudgetName": "$BUDGET_NAME",
  "BudgetLimit": { "Amount": "$BUDGET_LIMIT", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
EOF

for THRESHOLD in 10 25 50 90; do
  cat > "/tmp/compass-notif-$THRESHOLD.json" <<EOF
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": $THRESHOLD,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "$EMAIL" }
    ]
  }
]
EOF
done

aws budgets create-budget \
  --account-id "$ACCOUNT_ID" \
  --budget file:///tmp/compass-budget.json \
  --notifications-with-subscribers file:///tmp/compass-notif-10.json || \
  echo "Budget may already exist — check the console if this failed unexpectedly."

for THRESHOLD in 25 50 90; do
  aws budgets create-notification \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$BUDGET_NAME" \
    --notification "$(jq '.[0].Notification' "/tmp/compass-notif-$THRESHOLD.json")" \
    --subscribers "$(jq '.[0].Subscribers' "/tmp/compass-notif-$THRESHOLD.json")" || true
done

echo ""
echo "Done. Verify in the console: https://console.aws.amazon.com/billing/home#/budgets"
echo "Also confirm: root user has no access keys and MFA is enabled (COMPASS-1) —"
echo "that part is manual, the console makes it a 2-minute job, do it now if you haven't."
