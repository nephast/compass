# apps/agent-tools

The agentic tool-calling loop and its tool implementations. Called by `apps/api`
for requests that need more than a plain RAG lookup.

**Tickets:** COMPASS-19, COMPASS-21, COMPASS-22 (see `docs/PROGRAM.md`)

## TODO

- [ ] `LlmProvider` interface — `bedrock.ts` and `openrouter.ts` adapters, both implementing the same shape
- [ ] Tool registry with an **explicit allow-list** (no dynamic/arbitrary tool registration at runtime):
  - `get_aws_cost_summary` — Cost Explorer, last 7 days, read-only
  - `get_cloudwatch_alarm_status` — read-only
  - `get_recent_ci_runs` — GitHub Actions API, read-only
- [ ] Agent loop: bounded iteration count (hard cap, e.g. 5 tool calls per request), input validation on every tool argument before execution
- [ ] Log every tool call (name, args, result, duration) — this is your observability story for COMPASS-29/31
- [ ] Write the ADR for "why read-only tools only" (grill checkpoint in Epic 5 asks you to design the next write capability — do that as a follow-up ADR, not in the initial build)
