# Runbook: security baseline

A running checklist, not a one-time task — revisit at the end of every epic
that touches IAM, networking, or data.

## Identity & access

- [ ] No long-lived AWS access keys anywhere except your local CLI profile (CI uses OIDC — see `ci-aws-auth.md`).
- [ ] Every IAM role scoped to what it actually needs; no `Resource: "*"` or `Action: "*"` without a documented reason.
- [ ] IRSA for every pod that needs AWS access — no node instance profile with broad permissions that all pods inherit.
- [ ] Permission boundary (COMPASS-8) applied to every role Terraform/CDK creates.

## Network

- [ ] EKS nodes and RDS have no public IPs.
- [ ] Security groups are deny-by-default, explicit allow rules only, no `0.0.0.0/0` ingress except on the ALB/CloudFront edge.
- [ ] WAF on CloudFront and API Gateway (COMPASS-32).

## Data

- [ ] Encryption at rest (KMS) on RDS, S3, EBS volumes.
  - Documented exception: the CloudTrail log bucket uses SSE-S3, not KMS. A CMK
    bills per request and needs its own key policy granting CloudTrail
    `GenerateDataKey*` — cost and surface area for no threat this single-account
    project faces. Reasoning in ADR-0005.
- [ ] TLS in transit everywhere, including pod-to-pod where practical.
- [ ] No secrets in code, env files committed to git, or CDK/Terraform source — Secrets Manager or IAM auth only.
- [ ] `.env` is gitignored and there's no `.env` in git history (`git log --all --full-history -- .env` should be empty).

## Application

- [ ] JWT validated on every request that needs auth, at the API Gateway authorizer, not trusted from a header.
- [ ] Agent tool calls validated against an explicit allow-list, arguments schema-validated before execution (COMPASS-22).
- [ ] Dependency scanning (`npm audit`) and container scanning (Trivy) both failing CI on high/critical findings, not just reporting.

## CI

- [ ] Third-party GitHub Actions pinned to full commit SHA, not floating tags — see CVE-2026-33634 (Trivy supply-chain compromise, March 2026).
