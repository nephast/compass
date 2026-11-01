# ADR-0009: Edge protection — WAF on CloudFront, throttling on the HTTP API

**Status:** Proposed
**Date:** 2026-11-01
**Deciders:** nephast

## Context

COMPASS-32 asks for "WAF on CloudFront and API Gateway". While building it, one
fact changed the ticket: **API Gateway HTTP APIs cannot be associated with AWS WAF.**
WAF supports REST APIs, ALBs, CloudFront, AppSync, Cognito and App Runner — not HTTP
APIs. The ticket was written assuming otherwise.

## Decision

- **WAF on CloudFront** (us-east-1): a per-IP rate rule (100 requests / 5 minutes),
  `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesKnownBadInputsRuleSet`.
- **HTTP API protected by what it does support:** stage throttling (20 rps, burst 40,
  enforced before anything reaches the VPC) and the JWT authorizer, which rejects
  anonymous requests at the edge without invoking the backend.
- The internal ALB is reachable only from the VPC Link security group.

## Options Considered

### A: Switch to a REST API
Gets WAF directly. Costs ~3.5× per request, and loses the HTTP API's native JWT
authorizer (REST needs a Cognito authorizer or a Lambda authorizer). Rejected:
a framework swap to tick a box.

### B: Put CloudFront in front of the HTTP API too
One WAF for both origins, per-IP limits on the API. Adds a second distribution (or a
path behaviour on the first), header forwarding for `Authorization`, and — to stop
clients bypassing CloudFront — a shared-secret header the API must check. Real
merit, real complexity; the right next step if the API is ever abused.

### C: WAF on the internal ALB
Possible, but every request reaching it already came through the gateway, so the
source IP WAF sees is the VPC Link's, and per-IP rate limiting is meaningless there.

### D (chosen): CloudFront WAF + gateway throttling + authorizer
Cheapest (~$8/month for one web ACL), honest about the platform limit.

## Consequences

- The rate-limit acceptance test (many rapid requests from one IP → throttled) is
  run against the **CloudFront URL**: `scripts/waf-rate-test.sh`.
- The API's throttle is account-wide per stage, not per IP: one abusive
  authenticated user can consume the shared 20 rps. Option B fixes that.
- Revisit trigger: any sign of credential-stuffing or abuse on the API, or a move to
  multi-tenant users.
