# Runbook: incident response (COMPASS-35)

## 0. First five minutes

1. **Look, don't touch.** CloudWatch → Dashboards → `compass-dev`. The second row
   answers "what failed in the last hour and why" from the logs.
2. **Name the blast radius**: edge (everything 4xx/5xx), api only, ingestion only,
   or the agent only.
3. **Is it the last deploy?** Actions → Deploy to dev. If the failures began with a
   deploy, roll back first and investigate second (`rollback.md` A).
4. Write a one-line status somewhere visible, with a time.

## 1. Alarm-specific playbooks

### `compass-dev-api-5xx-rate`

```
Dashboard: "Failed requests, last hour: by route, status and reason"
```
- One route, one message (for example `/query` with `ThrottlingException`) → a dependency.
  Bedrock throttling: wait, or switch `LLM_COMPLETION_PROVIDER` (`packages/llm`).
- `/documents` and `/query` both failing with database errors → check RDS CPU credits
  and connections (RDS console → Monitoring).
- `503` with no api log lines → nothing is behind the ALB: `kubectl -n compass get pods`,
  then ALB target health (EC2 → Target groups → `compass-dev-api`).

### `compass-dev-ingestion-failed`

```bash
aws stepfunctions list-executions --state-machine-arn <arn> --status-filter FAILED --max-items 5
```
The "Documents that failed to ingest" widget groups by `reason`. An *unsupported*
or *empty* file never fails the execution (it's recorded on the document row). A
FAILED execution means retries were exhausted, almost always embedding throttling or
the database. Re-drive by re-uploading: ingestion is idempotent.

### `compass-dev-eks-node-not-ready`

```bash
kubectl get nodes; kubectl describe node <node>
```
The managed node group replaces an unhealthy instance itself. The api survives
one node (two replicas spread across nodes, PDB `minAvailable: 1`). If both nodes are
NotReady, check the NAT instance: nodes need it to reach ECR and the EKS endpoint
(interface endpoints are off by default).

### `compass-dev-ingest-lambda-errors`

Lambda → `Compass-dev-Ingestion-Ingest…` → Monitor → logs. `connect ETIMEDOUT` to
the database means security groups or RDS is stopped; `AccessDenied` on
`rds-db:connect` means the IAM policy or the `compass_app` grant (`database-bootstrap.md`).

### CloudTrail tamper email

Treat as a security incident. Someone ran `StopLogging` / `DeleteTrail` /
`UpdateTrail` / `PutEventSelectors`. The email names the principal, access key and
whether MFA was used. Re-apply `infra/terraform/envs/account`, then deactivate that
access key (IAM → Users → Security credentials) and look at what else it did:

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=<key> --max-results 50
```

## 2. Follow one request end to end (COMPASS-31, in under 60 seconds)

Every response carries a `traceId` (error bodies show it to the user). It is derived
from API Gateway's request id, and every log line in the api and agent-tools carries
it. Logs Insights, select **both** `/aws/containerinsights/compass-dev/application`
and the API access log group:

```
fields @timestamp, @log, log, status, route, requestId
| filter @message like "<traceId or the gateway requestId>"
| sort @timestamp asc
```

That shows the gateway's access-log line (status, latency, authorizer error), the
api's `request completed` and `rag retrieval` lines, and the agent's `tool call`
lines in order. An upload continues asynchronously: take the `key` from the api's
`upload presigned` line and search the ingest Lambda's log group for it. The Lambda
and Step Functions also emit X-Ray traces (tracing is on), which show per-call
latency to S3, RDS and Bedrock.

## 3. Afterwards

Blameless write-up within two days: timeline (with times), impact, what detected it
(alarm or a human?), contributing factors, and changes. The most useful question is
usually "why did the alarm fire late, or not at all?".
