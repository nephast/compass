# apps/agent-tools

The bounded tool-calling loop (COMPASS-21, COMPASS-22, ADR-0008). Internal only:
reached from `apps/api` over a ClusterIP Service, admitted by a NetworkPolicy.

## Tools (the whole allow-list)

| Tool | Backed by | Arguments |
|---|---|---|
| `get_aws_cost_summary` | Cost Explorer `GetCostAndUsage` (us-east-1, $0.01/call) | `days` 1–31, default 7 |
| `get_cloudwatch_alarm_status` | CloudWatch `DescribeAlarms` | `state`, `namePrefix` (bounded charset) |
| `get_recent_ci_runs` | GitHub Actions REST, **one** configured repo | `limit` 1–20, `branch` |

## Guardrails (`src/agent.ts`, `src/registry.ts`)

| Guardrail | How | Proved by |
|---|---|---|
| Allow-list | frozen `ToolRegistry`, no runtime registration; unknown names returned to the model as errors | `never executes a tool outside the allow-list` |
| Argument validation | Ajv, strict, against the **same** schema the model is shown, before execution; unknown properties rejected | `rejects malformed arguments BEFORE execution` |
| Iteration cap | max tool **executions** (default 5) and max model turns (6) per request | `can never exceed the tool-call cap…` |
| Logging | one `tool call` line per call: tool, args, args digest, status, duration, result size | `logs every tool call…` |
| Context safety | results truncated to 4000 chars; tool failures reported without stacks; prompt marks tool output as data | `reports a failing tool…` |

Logs Insights, "which tools failed in the last hour":

```
fields @timestamp, tool, status, durationMs, traceId
| filter message = "tool call" and status != "success"
| sort @timestamp desc
```

## Configuration

| Variable | Default | |
|---|---|---|
| `LLM_COMPLETION_PROVIDER` / `LLM_COMPLETION_MODEL` | `bedrock` / Nova Lite | `openrouter` and `fake` also work |
| `AGENT_SECRET_ID` | — | Secrets Manager JSON `{OPENROUTER_API_KEY?, GITHUB_TOKEN?}`, read via IRSA at boot |
| `GITHUB_REPOSITORY` | `nephast/compass` | |
| `AGENT_MAX_TOOL_CALLS` | `5` | |

```bash
LLM_COMPLETION_PROVIDER=fake npm run dev -w @compass/agent-tools
curl -XPOST localhost:8080/v1/chat -H 'content-type: application/json' \
  -d '{"message":"How much have I spent on AWS this week?"}'
```
