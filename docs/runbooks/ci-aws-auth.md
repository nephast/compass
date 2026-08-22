# Runbook: GitHub Actions → AWS auth via OIDC (no long-lived keys)

The CI workflows (`deploy-dev.yml`, `promote-prod.yml`, `infra-plan.yml`) assume
a `secrets.AWS_CI_ROLE_ARN` that GitHub Actions can assume via OpenID Connect —
**not** a static AWS access key stored as a GitHub secret. This is the modern
best practice (no long-lived credentials to leak) and a good thing to be able
to explain in an interview: "how does your CI authenticate to AWS" with the
answer "it doesn't hold credentials at all, it exchanges a short-lived OIDC
token for a scoped role" is a strong signal.

## Setup (do this once, via Terraform — part of Epic 1/COMPASS-8)

1. Create an IAM OIDC identity provider for `token.actions.githubusercontent.com` in your AWS account (one per account, reusable across repos).
2. Create an IAM role (`compass-ci-role`) with a trust policy scoped to **your specific repo** (and ideally branch — e.g. only `main` can assume the deploy role; PRs from any branch can assume a more limited plan-only role).
3. Attach a permission-boundary-constrained policy (COMPASS-8) — CI should be able to deploy `compass-*` resources, never touch anything else in the account, and never be able to grant itself broader permissions.
4. Add the role ARN as a repository secret: `AWS_CI_ROLE_ARN`. Add `AWS_REGION` and `ECR_REGISTRY` as repository variables.

## Why this over an access key

An access key is a long-lived credential sitting in GitHub's secret store — if it leaks (a misconfigured workflow that echoes secrets, a compromised Action dependency), it's valid until you notice and rotate it. An OIDC-assumed role token is valid for the duration of a single workflow run, scoped to exactly the trust policy you wrote. It's more setup up front for meaningfully less standing risk — the trade-off you'll defend in ADR form if you write one up (worth doing, it's a good ADR).
