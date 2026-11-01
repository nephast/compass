#!/usr/bin/env bash
# The whole product on one laptop, no AWS account, no spend:
#
#   LocalStack S3 + pgvector (docker compose) <- api <- frontend
#                     |                          |
#              ingestion watcher             agent-tools
#
# LLM providers default to the offline fakes. To use a real model locally:
#   LLM_COMPLETION_PROVIDER=openrouter OPENROUTER_API_KEY=... scripts/dev-stack.sh
# (embeddings stay fake locally: Titan needs AWS credentials).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run local:up

export LOCALSTACK_ENDPOINT="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"
export DATABASE_URL="${DATABASE_URL:-postgresql://compass:compass@localhost:5432/compass}"
export AWS_REGION="${AWS_REGION:-eu-west-1}"
export LLM_EMBEDDING_PROVIDER="${LLM_EMBEDDING_PROVIDER:-fake}"
export LLM_COMPLETION_PROVIDER="${LLM_COMPLETION_PROVIDER:-fake}"
export RAW_DOCUMENTS_BUCKET="${RAW_DOCUMENTS_BUCKET:-compass-raw-documents}"

cp apps/frontend/public/config.local.json apps/frontend/public/config.json

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM

PORT=8081 SERVICE_NAME=agent-tools npm run dev -w @compass/agent-tools & pids+=($!)
PORT=8080 AUTH_MODE=dev DOCUMENTS_BUCKET="$RAW_DOCUMENTS_BUCKET" \
  AGENT_TOOLS_URL=http://localhost:8081 RAG_MAX_DISTANCE="${RAG_MAX_DISTANCE:-0.95}" \
  npm run dev -w @compass/api & pids+=($!)
npm run watch -w @compass/ingestion & pids+=($!)
npm run dev -w @compass/frontend & pids+=($!)

echo
echo "Compass is starting: http://localhost:3000  (api :8080, agent-tools :8081)"
wait
