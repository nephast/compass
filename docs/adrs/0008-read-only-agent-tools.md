# ADR-0008: The agent gets read-only tools only, enforced in code

**Status:** Proposed
**Date:** 2026-11-01
**Deciders:** nephast

## Context

`agent-tools` runs a model-driven loop that can call tools (COMPASS-21). The model's
output is untrusted input: it is steered by the user's message, and indirectly by
anything that reaches its context — tool results included (a CI run title, an alarm
description). Whatever the tools *can* do, a sufficiently adversarial prompt can
eventually make the model *ask* to do.

## Decision

1. **Three read-only tools**, fixed at build time: `get_aws_cost_summary` (Cost
   Explorer), `get_cloudwatch_alarm_status` (CloudWatch `DescribeAlarms`),
   `get_recent_ci_runs` (GitHub Actions, one configured repository).
2. **Guardrails live in code, not in the prompt** (COMPASS-22): a frozen registry
   (no runtime registration), JSON-Schema validation of every argument before
   execution (the same schema the model is shown), a cap on tool executions *and*
   on model turns per request, truncation of tool results, and a structured log
   line per call.
3. **IAM is the last line**: the pod's IRSA role carries only `ce:GetCostAndUsage`
   and `cloudwatch:DescribeAlarms` (plus reading its one secret), so even a bug in
   the registry cannot turn into a write.

## Options Considered

### Option A: Read-only allow-list (chosen)
**Pros:** the worst case of a fully hijacked model is information disclosure about
cost and alarms, to an already-authenticated user of a single-tenant account.
**Cons:** the assistant can diagnose but never remediate.

### Option B: Allow-list including writes, gated by prompt instructions
**Cons:** a prompt is a request, not a control. Prompt injection through tool
results makes "the model will only restart pods when asked" unenforceable.

### Option C: Generic tools (shell, arbitrary AWS API call)
**Cons:** the blast radius equals the role's permissions; rejected outright.

## Trade-off Analysis

The value of an ops assistant is mostly in *finding out* (what did we spend, what
is alarming, what broke in CI). Remediation is where the risk is, and it is the
part a human should still own at this stage. Read-only buys almost all the value
for almost none of the risk.

## Consequences

- Hijacking the model can at worst read cost/alarm/CI data — which the user could
  read in the console anyway.
- Each `get_aws_cost_summary` call costs $0.01; the tool-call cap bounds spend per
  request as well as latency.
- **The next write capability** (the Epic 5 grill checkpoint) should be the smallest
  reversible one — e.g. "silence an alarm for 1 hour" — and needs, before it ships:
  a human confirmation step outside the model (the API returns a proposed action, the
  user clicks), an IAM role scoped to that single action, an audit log entry per
  action, and a new ADR.

## Action Items

1. [x] Frozen registry, Ajv validation, iteration caps, per-call logging
2. [x] IRSA role scoped to the two read actions (`infra/cdk/lib/api-stack.ts`, `AgentRole`)
3. [ ] Write the follow-up ADR before any write tool exists
