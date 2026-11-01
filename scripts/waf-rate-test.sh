#!/usr/bin/env bash
# COMPASS-32 acceptance: many rapid requests from one IP get blocked by WAF.
#
#   scripts/waf-rate-test.sh https://dxxxxxxxx.cloudfront.net
#
# WAF evaluates rate rules over a sliding window and takes up to ~30s to start
# blocking after the threshold (100 requests / 5 min) is crossed, so this sends
# a burst, then polls until it sees a 403 or gives up.
set -euo pipefail
URL="${1:?usage: $0 <cloudfront-url>}"

echo "sending 300 requests to $URL ..."
for _ in $(seq 1 300); do curl -s -o /dev/null "$URL/" & done; wait

for attempt in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/")
  echo "attempt $attempt: HTTP $code"
  if [ "$code" = "403" ]; then
    echo "PASS: rate limit is blocking this IP (it unblocks once the 5-minute window drains)"
    exit 0
  fi
  sleep 10
done
echo "FAIL: never throttled" >&2
exit 1
