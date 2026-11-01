#!/usr/bin/env bash
# COMPASS-37: what did Compass actually cost, by service, from Cost Explorer.
#
#   scripts/cost-report.sh 2026-08-24 2026-11-02 > /tmp/cost.md
#
# Two views:
#   1. everything in the account, by service (the credit pays for all of it)
#   2. only resources tagged Project=compass, by service -- this needs the
#      Project tag ACTIVATED as a cost allocation tag (Billing -> Cost allocation
#      tags), and only counts usage from after activation.
# The difference between the two is untagged spend: EKS control plane hours
# before tagging, data transfer, Cost Explorer API calls, tax.
#
# Each GetCostAndUsage call costs $0.01. This script makes three.
set -euo pipefail
START="${1:?usage: $0 <start YYYY-MM-DD> <end YYYY-MM-DD, exclusive>}"
END="${2:?usage: $0 <start YYYY-MM-DD> <end YYYY-MM-DD, exclusive>}"

query() {
  aws ce get-cost-and-usage --region us-east-1 \
    --time-period "Start=$START,End=$END" --granularity MONTHLY \
    --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE "$@" \
    --output json
}

table() {
  python3 -c '
import json, sys
data = json.load(sys.stdin)
totals = {}
for period in data["ResultsByTime"]:
    for group in period["Groups"]:
        amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
        totals[group["Keys"][0]] = totals.get(group["Keys"][0], 0) + amount
rows = sorted(((s, a) for s, a in totals.items() if a >= 0.005), key=lambda r: -r[1])
print("| Service | USD |\n|---|---:|")
for service, amount in rows:
    print(f"| {service} | {amount:.2f} |")
print(f"| **Total** | **{sum(a for _, a in rows):.2f}** |")
'
}

echo "# Compass cost report, $START to $END (end exclusive)"
echo
echo "## Whole account, by service (unblended, before credits)"
echo
query | table
echo
echo "## Tagged Project=compass, by service"
echo
query --filter '{"Tags":{"Key":"Project","Values":["compass"]}}' | table
echo
echo "## Credits applied"
echo
aws ce get-cost-and-usage --region us-east-1 --time-period "Start=$START,End=$END" \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}' --output json |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("Credits: %.2f USD" % sum(float(p["Total"]["UnblendedCost"]["Amount"]) for p in d["ResultsByTime"]))'
