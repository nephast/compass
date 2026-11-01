# Runbook: rollback (COMPASS-35)

## Decide which layer broke

| Symptom | Layer | Go to |
|---|---|---|
| Smoke test fails right after a deploy; 5xx in "Failed requests, last hour" | **pods** (new image) | A |
| A CDK deploy failed | **app infra** | B — usually nothing to do |
| Frontend broken, API fine | **static site** | C |
| A migration broke queries | **schema** | D |

## A. Pods: `kubectl rollout undo` (automatic in CI)

`deploy-dev.yml` does this itself when the smoke test fails. By hand:

```bash
aws eks update-kubeconfig --name compass-dev --region eu-west-1
kubectl -n compass rollout history deployment/api      # change-cause shows each revision's SHA
kubectl -n compass rollout undo deployment/api          # or --to-revision=<n>
kubectl -n compass rollout undo deployment/agent-tools
kubectl -n compass rollout status deployment/api --timeout=180s
scripts/smoke-test.sh dev
```

**What `rollout undo` actually does** (the Epic 7 grill question): a Deployment keeps
its old ReplicaSets (`revisionHistoryLimit: 5`). `undo` copies the previous
ReplicaSet's pod template back into the Deployment. That is a normal rolling update
in reverse: with `maxUnavailable: 0, maxSurge: 1`, a pod from the old template must
pass readiness before a new-template pod is removed, so capacity never drops. The
old image is still in ECR (immutable tags, 15 kept) and usually still cached on the
nodes, so it takes **~20–40 seconds**. Nothing is rebuilt, and no git revert is
needed to stop the bleeding. Revert the commit afterwards, so the next merge doesn't
redeploy the bad code.

## B. App infra (CDK)

CloudFormation rolls a failed stack update back by itself; check the stack is
`UPDATE_ROLLBACK_COMPLETE`. To undo a change that *succeeded* but is wrong, revert
the commit and let `deploy-dev.yml` redeploy. If a stack is stuck in
`UPDATE_ROLLBACK_FAILED`, use `aws cloudformation continue-update-rollback --stack-name <stack>`.

## C. Static site

Revert the frontend commit and merge. The Site stack re-uploads the previous build
and invalidates CloudFront in the same deploy (~3–5 minutes).

## D. Schema

Migrations are forward-only by default. `npm run migrate:down -w @compass/db` steps
back **one** migration and is destructive (it drops what the up migration added).
Prefer a new forward migration that fixes the problem. Roll pods back first (A) if
the new code depends on the new schema.
