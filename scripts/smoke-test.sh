#!/usr/bin/env bash
# COMPASS-28: post-deploy smoke test, run by CI after every deploy and
# runnable by hand:  scripts/smoke-test.sh dev
#
# Proves the deployed path end to end, not just that pods are Ready:
#   1. GET /healthz through API Gateway -> VPC Link -> ALB -> pod
#   2. an unauthenticated request is rejected with 401 at the edge
#   3. a dedicated smoke-test user signs in (Cognito AdminInitiateAuth, which
#      needs the CI role's IAM credentials -- the client has no browser flow)
#   4. it uploads a known document (idempotent: the same bytes from the same
#      user are recorded as a duplicate, never re-embedded -- COMPASS-12)
#   5. it asks a question only that document answers, and FAILS unless the
#      answer cites it
#
# Needs: aws, curl, python3. The smoke user's credentials live in Secrets
# Manager at compass/<env>/smoke-test-user as {"username": ..., "password": ...}
# (docs/runbooks/deploy.md, "one-time setup").
set -euo pipefail

ENV="${1:?usage: $0 <dev|prod>}"
REGION="${AWS_REGION:-eu-west-1}"
param() { aws ssm get-parameter --region "$REGION" --name "/compass/$ENV/app/$1" --query Parameter.Value --output text; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

API="${COMPASS_API_URL:-$(param api_url)}"
POOL="$(param cognito_user_pool_id)"
# The smoke client is the second of the two published ids (web, smoke).
CLIENT="$(param cognito_client_id | cut -d, -f2)"
echo "Smoke testing $ENV at $API"

# 1. health
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/healthz")
[ "$code" = "200" ] || fail "/healthz returned $code"
echo "OK  /healthz"

# 2. the edge rejects anonymous calls
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/documents")
[ "$code" = "401" ] || fail "unauthenticated /documents returned $code, expected 401"
echo "OK  unauthenticated request rejected (401)"

# 3. sign in
creds=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "compass/$ENV/smoke-test-user" --query SecretString --output text)
user=$(echo "$creds" | json 'd["username"]')
pass=$(echo "$creds" | json 'd["password"]')
token=$(aws cognito-idp admin-initiate-auth --region "$REGION" --user-pool-id "$POOL" \
  --client-id "$CLIENT" --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$user,PASSWORD=$pass" \
  --query AuthenticationResult.AccessToken --output text)
auth=(-H "authorization: Bearer $token")
echo "OK  signed in as the smoke-test user"

# 4. seed the known document (no-op after the first run)
doc="$(dirname "$0")/../docs/demo/sample-runbook.md"
size=$(wc -c < "$doc" | tr -d ' ')
target=$(curl -sf "${auth[@]}" -H 'content-type: application/json' -X POST "$API/documents/upload-url" \
  -d "{\"fileName\":\"smoke-runbook.md\",\"size\":$size}")
url=$(echo "$target" | json 'd["url"]')
curl -sf -X PUT -H 'content-type: text/markdown' --data-binary "@$doc" "$url" >/dev/null \
  || fail "presigned upload was rejected by S3"
echo "OK  presigned upload accepted by S3"

# Ready when any copy of it is embedded (a re-upload lands as "duplicate").
for _ in $(seq 1 30); do
  ready=$(curl -sf "${auth[@]}" "$API/documents" | json \
    'any(x["fileName"]=="smoke-runbook.md" and x["status"]=="embedded" for x in d["documents"])')
  [ "$ready" = "True" ] && break
  sleep 5
done
[ "$ready" = "True" ] || fail "smoke-runbook.md never reached status embedded (check the ingestion alarm)"
echo "OK  document ingested"

# 5. a real RAG query that must cite it
answer=$(curl -sf "${auth[@]}" -H 'content-type: application/json' -X POST "$API/query" \
  -d '{"question":"How do I roll back a bad deploy?"}')
cited=$(echo "$answer" | json 'any(c["fileName"]=="smoke-runbook.md" for c in d["citations"])')
[ "$cited" = "True" ] || fail "RAG answer did not cite the seeded document: $answer"
echo "OK  RAG answer cites the seeded document"

echo "Smoke test passed for $ENV."
