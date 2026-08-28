# Runbook: AWS account setup (COMPASS-1, COMPASS-2)

Do this before writing any infrastructure code.

## 1. Root user

- [ ] Enable MFA on the root user (console → Security credentials).
- [ ] Confirm root has **no** access keys. Delete any that exist.
- [ ] Never sign in as root again except for the handful of actions that require it (e.g. closing the account).

## 2. A real IAM identity for daily work

- [ ] IAM Identity Center (recommended, even for a single-person account — it's what you'd use at a real job) or a plain IAM user with MFA enforced and an attached policy (start broad for learning speed, tighten as ADR-0003/COMPASS-8 permission boundaries land).
- [ ] Configure the AWS CLI against this identity: `aws configure sso` or `aws configure` with an access key on the IAM user (not root).

## 3. CloudTrail

**Do not create this in the console.** It is Terraform, in `infra/terraform/envs/account`
(a separate root and state file from `envs/dev`, so `scripts/teardown.sh` cannot
destroy it). See ADR-0005 — a console-created trail was deleted as apparent
drift precisely because nothing in the repo recorded that it was deliberate.

- [ ] `cd infra/terraform/envs/account && terraform init && terraform apply`
- [ ] Confirm delivery, which is *not* implied by the apply succeeding:
      `aws cloudtrail get-trail-status --name compass-management-events --region eu-west-1`
      — want `LatestDeliveryTime` set and `LatestDeliveryError` absent. First
      delivery takes a few minutes.

## 4. Budgets

- [ ] Run `./scripts/setup-aws-guardrails.sh you@example.com` (COMPASS-2).
- [ ] Verify at least one test notification actually arrives.

## 5. Bedrock model access

- [ ] Console → Bedrock → Model access → request access to whichever model(s) you plan to use for embeddings and completions. This can take a few minutes to a few hours to be approved — do it now, on day one, so it's not a blocker later (COMPASS-19).

## Session log

Keep a one-line log here of any manual console changes you make that aren't captured in Terraform/CDK — useful both for your own sanity and as an honest answer to "is everything in this repo actually reproducible from IaC."

| Date | What | Why |
|------|------|-----|
| 2026-08-24 | CloudTrail trail + log bucket created by hand in the console (eu-west-2) | Epic 0 speed. **This is the entry that was never written at the time** — and its absence is why the trail read as drift and was deleted on 2026-08-28. Now rebuilt in Terraform; see ADR-0005. |
| 2026-08-28 | Deleted that trail and its bucket | Believed to be untracked drift in an unused region. It was not — it was satisfying COMPASS-1. |
