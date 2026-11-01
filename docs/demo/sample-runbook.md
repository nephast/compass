# Compass on-call runbook

## Rolling back a bad deploy

If the post-deploy smoke test fails, roll back with kubectl rollout undo deployment/api -n compass. The previous ReplicaSet is still present, so the rollback completes in about thirty seconds without rebuilding any image.

Confirm the rollback with kubectl rollout status and check that /healthz returns 200 through the API Gateway URL.

## When ingestion stalls

Open the Step Functions console and look for executions in the FAILED state. The Lambda log records the document's failure_reason, for example an unsupported file type or a Bedrock throttling error.

## Cost guardrails

The EKS control plane bills ten cents an hour from the moment the cluster exists. Run scripts/teardown.sh at the end of every working session.
