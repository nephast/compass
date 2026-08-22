#!/usr/bin/env bash
# COMPASS-28: post-deploy smoke test, run by CI after every deploy (and
# runnable manually: ./scripts/smoke-test.sh dev).
#
# TODO: replace the placeholder URL/checks below once COMPASS-16/17 exist.

set -euo pipefail

ENV="${1:?Usage: $0 <dev|prod>}"
BASE_URL="${COMPASS_API_URL:?Set COMPASS_API_URL for the $ENV environment}"

echo "Smoke testing $ENV at $BASE_URL ..."

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/healthz")
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "FAIL: /healthz returned $HEALTH_STATUS"
  exit 1
fi
echo "OK: /healthz"

# TODO (COMPASS-28): add a real authenticated RAG query smoke test once
# COMPASS-20 exists — e.g. ask a question against a known seeded document and
# assert the response actually cites it.

echo "Smoke test passed for $ENV."
