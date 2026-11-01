#!/usr/bin/env bash
# Deploy api + agent-tools to EKS (COMPASS-17, used by CI in COMPASS-27).
#
#   scripts/k8s-deploy.sh <env> <image-tag>
#
# 1. Reads every environment-specific value from SSM Parameter Store -- the
#    seam Terraform and CDK publish to -- into the overlay's gitignored
#    config.env / irsa.env. Nothing account-specific is ever committed.
# 2. Builds a throwaway kustomization pinning both images to <image-tag> (the
#    git SHA). Promotion to prod passes the SHA dev already ran.
# 3. Applies, then waits for both rollouts. A rollout that does not become
#    Ready fails this script, and therefore the pipeline.
set -euo pipefail

ENV="${1:?usage: $0 <env> <image-tag>}"
TAG="${2:?usage: $0 <env> <image-tag>}"
REGION="${AWS_REGION:-eu-west-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$ROOT/infra/k8s/overlays/$ENV"
[ -d "$OVERLAY" ] || { echo "no overlay for $ENV at $OVERLAY" >&2; exit 1; }

param() {
  aws ssm get-parameter --region "$REGION" --name "/compass/$ENV/$1" \
    --query Parameter.Value --output text
}

REGISTRY="$(param ecr/registry)"
CLUSTER="$(param eks/cluster_name)"

cat > "$OVERLAY/config.env" <<CONFIG
AWS_REGION=$REGION
DOCUMENTS_BUCKET=$(param app/documents_bucket)
COGNITO_USER_POOL_ID=$(param app/cognito_user_pool_id)
COGNITO_CLIENT_ID=$(param app/cognito_client_id)
DB_HOST=$(param db/endpoint)
DB_PORT=$(param db/port)
DB_NAME=$(param db/name)
DB_USER=$(param db/iam_username)
AGENT_SECRET_ID=$(param app/agent_secret_id)
LLM_EMBEDDING_PROVIDER=${LLM_EMBEDDING_PROVIDER:-bedrock}
LLM_COMPLETION_PROVIDER=${LLM_COMPLETION_PROVIDER:-bedrock}
CONFIG

cat > "$OVERLAY/irsa.env" <<IRSA
API_ROLE_ARN=$(param app/api_role_arn)
AGENT_ROLE_ARN=$(param app/agent_role_arn)
IRSA

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/kustomization.yaml" <<KUSTOMIZE
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - $OVERLAY
images:
  - name: compass-api
    newName: $REGISTRY/compass-api
    newTag: "$TAG"
  - name: compass-agent-tools
    newName: $REGISTRY/compass-agent-tools
    newTag: "$TAG"
KUSTOMIZE

aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" >/dev/null
kubectl apply -k "$WORK"

# Record what changed, so `kubectl rollout history` says which SHA each
# revision was -- the first thing you want during a rollback.
for deploy in api agent-tools; do
  kubectl -n compass annotate "deployment/$deploy" \
    kubernetes.io/change-cause="deploy $TAG" --overwrite >/dev/null
done

kubectl -n compass rollout status deployment/api --timeout=180s
kubectl -n compass rollout status deployment/agent-tools --timeout=180s
echo "deployed $TAG to $ENV ($CLUSTER)"
