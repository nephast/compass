# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Compass is a portfolio/learning project: a RAG + agentic-ops assistant, built as a deliberate teaching scaffold. **The repo is currently a scaffold — `apps/*` and `infra/*` contain READMEs and stubs, no implementation yet.** Every directory README lists TODOs tied to ticket IDs (`COMPASS-N`) defined in `docs/PROGRAM.md`.

Because it is a learning project, the intended mode of work is *mentoring, not ghostwriting*: the user writes the implementation and wants review, trade-off pressure, and pointers to the relevant ticket's acceptance criteria. Do not implement whole epics unprompted; when asked for help, prefer explaining the decision space and reviewing their diff over dropping in a finished solution. `docs/PROGRAM.md` also carries "grill checkpoint" questions per epic — those are for the user to answer, not for Claude to answer for them.

## Ticket tracking

Tickets live on **GitHub Project #2, "Compass Build Program"** (https://github.com/users/nephast/projects/2), backed by issues in this repo — `COMPASS-1` … `COMPASS-38` map to issues **#6 … #43** in order (`COMPASS-N` = issue `N + 5`). Each issue carries its acceptance criteria verbatim from `docs/PROGRAM.md`.

The board is the source of truth for **what's done**; `docs/PROGRAM.md` is the source of truth for **what each ticket means** — read the epic's "why it matters" preamble there before starting, not just the issue.

Issues are labelled `epic-0`…`epic-9` and `core`/`stretch`; the project has matching `Epic` and `Track` single-select fields. Only COMPASS-31 (distributed tracing) is STRETCH. Check state with `gh issue list --label epic-N` rather than assuming — it moves between sessions.

## Commands

```bash
npm install
npm run lint          # eslint across workspaces (--if-present, so no-ops on empty workspaces)
npm run typecheck
npm run test
npm run build
docker compose up -d  # LocalStack (s3, sqs, events, stepfunctions, lambda, secretsmanager) + pgvector Postgres
```

Root scripts fan out via `npm run <script> --workspaces --if-present` over `apps/*` and `infra/cdk`. Workspaces have no `package.json` yet — when creating one, add `lint`/`typecheck`/`test`/`build` scripts or CI silently skips it. Single-test invocation is per-workspace and depends on the test runner each app picks (`npm run test -w apps/api -- <pattern>`).

Node 24 (`.nvmrc`, CI `setup-node`); `engines` allows >=22.13.

## Architecture in one paragraph

Hybrid by design (see `docs/ARCHITECTURE.md` for the diagram and the reasoning):

- **Ingestion is serverless** — S3 `ObjectCreated` → EventBridge → Step Functions → chunk Lambda → SQS (+DLQ) → embed Lambda → store Lambda → RDS Postgres/pgvector. Handlers must be idempotent (COMPASS-12).
- **API and agent run on EKS** — `apps/api` (HTTP, RAG query flow) delegates tool-calling to `apps/agent-tools`. Chosen over Fargate specifically to get Kubernetes reps (ADR-0003), accepting the ~$73/mo control-plane cost.
- **Frontend** is Next.js on S3 + CloudFront (OAC), fronted by API Gateway HTTP API with a Cognito JWT authorizer and a VPC Link into EKS.
- **LLM access always goes through the internal `LlmProvider` interface** (Bedrock and OpenRouter adapters), never the vendor SDKs directly. Swapping providers must stay a config change.
- **Agent tools are an explicit read-only allow-list** (`get_aws_cost_summary`, `get_cloudwatch_alarm_status`, `get_recent_ci_runs`) with validated arguments and a hard cap on tool-call iterations. No dynamic tool registration, no write tools without an ADR first.

### The two-IaC seam

`infra/terraform` owns the platform layer (VPC, EKS, ECR, IAM permission boundaries, Budgets) and is **applied manually — CI only plans, never applies**. `infra/cdk` owns application infra (S3, CloudFront, API Gateway, Lambda, Step Functions, Cognito). Terraform writes outputs (VPC ID, subnet IDs, EKS OIDC provider ARN) to **SSM Parameter Store**; CDK reads them from there. Never hardcode or `.env` these across the seam. CDK stacks are per-environment via context (`--context env=dev`), and every resource is tagged `Project=compass` / `Environment=<env>` for the cost report (COMPASS-37).

## Working conventions

- **Trunk-based, enforced.** Branch off `main` as `feat/compass-19-short-description`; `main` is protected. Individual commits can be messy — the **PR title** must be Conventional Commits (`feat|fix|chore|docs|test|refactor|ci|perf|security|revert`), because squash-merge makes it the permanent commit. Keep PRs to one ticket.
- **Definition of done** (per `docs/PROGRAM.md`): merged via small PR, CI green, and — where a decision is worth defending — a new ADR in `docs/adrs/` (use `0000-template.md`) or an update to `docs/ARCHITECTURE.md` / `docs/SCALING.md`.
- Prettier: double quotes, semicolons, trailing commas, 100 cols. TS is `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.base.json`) — workspaces should extend it. ESLint flags `no-console` (allows `warn`/`error`) and warns on `any`.
- Structured JSON logging and trace propagation are meant to be written in from day one (COMPASS-29/31), not retrofitted.
- Third-party GitHub Actions are **SHA-pinned** with a version comment; keep that pattern when adding steps. AWS auth in CI is OIDC (`id-token: write`) — no static keys.
- Many CI jobs are gated behind `if: false` with a `TODO (COMPASS-N)` comment; flip them on in the PR that makes them meaningful, rather than leaving them permanently off.

## Cost discipline

This runs on a new AWS account against a $100 credit. EKS bills from the moment the cluster exists. Before suggesting anything that provisions AWS resources, weigh the cost, and remember `scripts/teardown.sh` exists and is meant to be run at the end of sessions. `scripts/setup-aws-guardrails.sh` sets Budgets alerts at $10/$25/$50/$90 and is deliberately local-only, never CI.

## This repo is public

`nephast/compass` is a public repo, and so are its issues, PRs, and project board. Nothing committed here should contain an AWS account ID, an ARN carrying one, a Cognito pool/client ID, an RDS endpoint, or any real credential — use placeholders in docs, ADRs, runbooks, and issue bodies. `.env` is gitignored and holds the real OpenRouter key; `.env.example` is the shape to reference. Same check applies to screenshots and the demo recording (COMPASS-36).
