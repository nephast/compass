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

- [ ] Enable a trail covering all regions, management events. Free tier covers this for a single trail.

## 4. Budgets

- [ ] Run `./scripts/setup-aws-guardrails.sh you@example.com` (COMPASS-2).
- [ ] Verify at least one test notification actually arrives.

## 5. Bedrock model access

- [ ] Console → Bedrock → Model access → request access to whichever model(s) you plan to use for embeddings and completions. This can take a few minutes to a few hours to be approved — do it now, on day one, so it's not a blocker later (COMPASS-19).

## Session log

Keep a one-line log here of any manual console changes you make that aren't captured in Terraform/CDK — useful both for your own sanity and as an honest answer to "is everything in this repo actually reproducible from IaC."

| Date | What | Why |
|------|------|-----|
| | | |
