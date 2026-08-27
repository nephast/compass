# The Compass Build Program

A 2-week, half-day-sessions curriculum for building Compass end to end: general coding/architecture reps, AWS depth (especially containers/K8s/networking/security, since serverless is already your day job), a real CI/CD pipeline, and a portfolio piece that survives a system-design interview.

## How to use this

**No rigid day numbers.** Milestones are grouped into **epics**, each broken into **tickets** (`COMPASS-1`, `COMPASS-2`, …) sized to roughly one sitting each — small enough to start and finish in a single focus block, not "spend a whole day on vague thing." Work epics roughly in order (later ones depend on earlier ones) but pace yourself within an epic however your energy that day allows. Each epic has a rough session estimate as a sanity check, not a deadline.

**Every epic is tagged CORE or STRETCH.** CORE is the spine of the portfolio piece — if you only get through CORE work in two weeks, you still have a complete, coherent, defensible system. STRETCH is where the deeper flexes live (tracing, WAF, semantic-release, mock EKS chaos testing). Do stretch work only after the current epic's CORE tickets are done, and feel free to skip straight past stretch items you're not enjoying — an abandoned stretch ticket costs you nothing; an unfinished CORE epic costs you the whole story.

**Definition of done, per ticket:** code merged to `main` via a small PR, passing CI, with a conventional commit message, and — where the ticket touches a decision worth defending — an ADR or a paragraph in `docs/ARCHITECTURE.md`/`docs/SCALING.md` updated. "It works on my machine" is not done. "I can explain why I built it this way" is done.

**Mentor mode:** this scaffold, the CI shells, and the IaC stubs are built for you; the actual implementation code is not. Open a PR when a ticket's acceptance criteria are met (even partially — small PRs beat big ones) and treat the review as the learning moment, not a formality.

**Start-of-session ritual (30 seconds, every session):** check the AWS Budgets dashboard. That's it. That's the ritual. Skipping it is how portfolio projects turn into surprise bills.

---

## Epic 0 — Foundations & Guardrails (CORE, ~1 session)

*Why it matters:* every real job starts with "can I even safely make changes here" before "what should I build." Account hygiene, budget guardrails, and a working CI skeleton are table stakes, and "how do you make sure a new AWS account doesn't rack up surprise cost" is a fair interview question you should be able to answer from lived experience after this.

- **COMPASS-1** — AWS account baseline: enable MFA on the root user, create an IAM Identity Center user (or IAM user + MFA) for daily work, stop using root entirely, enable CloudTrail (management events, all regions). *Acceptance: root user has no access keys, MFA enforced, CloudTrail trail visible in console.*
- **COMPASS-2** — AWS Budgets: create a budget against the $100 credit with alerts at $10/$25/$50/$90, SNS topic → your email. *Acceptance: a test alert (e.g. temporarily set a $0 threshold) actually lands in your inbox.*
- **COMPASS-3** — GitHub repo: push this scaffold, protect `main` (require PR + passing CI, no direct pushes, no force-push), add the conventional-commit CI check from `.github/workflows/pr-checks.yml`. *Acceptance: a direct push to `main` is rejected; a PR with a bad commit message fails CI.*
- **COMPASS-4** — Local dev loop: `docker compose up` brings up LocalStack + Postgres/pgvector; `npm run dev` runs something (even a hello-world) end to end locally. *Acceptance: you can develop and test the ingestion Lambda logic without touching real AWS.*

**Grill checkpoint:** *"Walk me through what happens, step by step, if someone gets your GitHub PAT. What can they actually do, and what stops them from doing more?"*

---

## Epic 1 — Platform Foundation: Terraform (CORE, ~2-3 sessions)

*Why it matters:* this is the "platform engineer" half of the story — VPC design and EKS-cluster-from-scratch are exactly the depth you said you wanted, and they're the parts of the stack most candidates can only describe, not demonstrate.

- **COMPASS-5** — VPC module: public + private subnets across 2 AZs, route tables, the NAT-instance + VPC-endpoint setup from ADR-0001. *Acceptance: `terraform plan` is clean; a resource in a private subnet can reach ECR/S3 but has no public IP.*
- **COMPASS-6** — EKS cluster module: control plane, OIDC provider for IRSA, node group or Fargate profile (decide and document as a follow-up note on ADR-0003). *Acceptance: `kubectl get nodes` works from your machine via `aws eks update-kubeconfig`.*
- **COMPASS-7** — ECR repos for `api` and `agent-tools` images, lifecycle policy to expire untagged images (cost hygiene). *Acceptance: `docker push` to ECR succeeds from local.*
- **COMPASS-8** — IAM permission boundaries: a boundary policy applied to any role Terraform creates, so even a compromised/misconfigured IaC run can't grant admin. *Acceptance: attempt to attach `AdministratorAccess` to a boundary-constrained role and watch it get denied.*

**Grill checkpoint:** *"Your NAT instance dies at 2am. What actually breaks, what doesn't, and how would you find out before a user tells you?"*

---

## Epic 2 — Serverless Ingestion Pipeline: CDK (CORE, ~2 sessions)

*Why it matters:* this is your serverless refresher, and it's deliberately built to the pattern you'd defend in a system design interview — event-driven, idempotent, with a dead-letter queue — not the "one Lambda does everything" version.

- **COMPASS-9** — S3 bucket for raw documents + presigned-upload Lambda behind API Gateway. *Acceptance: you can `curl` a presigned URL and PUT a file successfully.*
- **COMPASS-10** — EventBridge rule on S3 `ObjectCreated`, feeding a Step Functions state machine. *Acceptance: uploading a file visibly starts an execution in the Step Functions console.*
- **COMPASS-11** — Chunk Lambda → SQS (with DLQ, max receive count, redrive policy) → Embed Lambda (calls Bedrock or OpenRouter via the provider abstraction) → Store Lambda (writes to pgvector). *Acceptance: a real PDF/text file, uploaded, ends up as searchable rows in Postgres, and a deliberately malformed file lands in the DLQ instead of retrying forever.*
- **COMPASS-12** — Idempotency: re-uploading the same file (or replaying an SQS message) doesn't duplicate vectors. *Acceptance: upload the same file twice, row count doesn't double.*

**Grill checkpoint:** *"An embed Lambda times out halfway through a 200-page document. What's the blast radius, and how do you know which chunks made it and which didn't?"*

---

## Epic 3 — Data Layer (CORE, ~1 session)

- **COMPASS-13** — RDS Postgres (`db.t3.micro`) + `pgvector` extension, private subnet, security group scoped to EKS node SG + Lambda SG only, IAM database authentication (no long-lived password). *Acceptance: connect from a pod using an IRSA-scoped IAM role, not a password.*
- **COMPASS-14** — Migrations: pick a tool (Prisma, Drizzle, or plain SQL + `node-pg-migrate`), write the schema (documents, chunks, embeddings, users, ingestion_jobs). *Acceptance: `npm run migrate` is idempotent and runs cleanly against a fresh database.*

**Grill checkpoint:** *"Why did you pick IAM auth over a password in Secrets Manager? What's the actual attack this defends against that Secrets Manager rotation doesn't?"*

---

## Epic 4 — Core API + Auth (CORE, ~2-3 sessions)

*Why it matters:* real authN/authZ, not a stub — this is the piece most portfolio projects skip and most interviewers probe.

- **COMPASS-15** — Cognito User Pool + app client, signup/login flow. *Acceptance: you can create a user and get back a valid JWT.*
- **COMPASS-16** — API Gateway HTTP API with a JWT authorizer in front of the EKS service via VPC Link. *Acceptance: an unauthenticated request is rejected with 401; an authenticated one reaches the pod.*
- **COMPASS-17** — `api` service on EKS: Deployment, Service, resource requests/limits, readiness + liveness probes, HPA on CPU (or a custom metric — stretch). *Acceptance: `kubectl top pods` shows sane resource usage; killing a pod causes a clean, fast replacement, not a cascading failure.*
- **COMPASS-18** — Ingress/ALB wiring from API Gateway's VPC Link to the service.
- **COMPASS-39** — Multi-agent development workflow trial: take one ticket from this epic (or Epic 5) through implementer agent → *independent* reviewer agent → fixer agent → human merge gate, then write up ADR-0004. Added after the original 38; deliberately lands here because it needs application code with real unit tests, not Terraform — an agent needs a correctness signal it can run itself, and infra has a weak local feedback loop with an expensive failure mode. Do the first run manually across separate sessions before automating anything. *Acceptance: the trial PR is linked on the issue, the reviewer agent demonstrably ran with no implementation context, at least one of its comments caused a genuine change, the human merge gate was never bypassed, and `docs/adrs/0004-ai-assisted-development-workflow.md` has moved `Proposed` → `Accepted` carrying real alternatives, a dated "as of", and a revisit trigger.*

**Grill checkpoint:** *"A user's JWT is stolen. Walk me through exactly what they can do with it and for how long, and what you'd change to shrink that window."*

---

## Epic 5 — RAG + Agentic Ops (CORE, ~2-3 sessions)

*Why it matters:* this is the headline feature and the part of the repo an interviewer will actually poke at. RAG alone is table stakes now — the agentic tool-calling loop, with a bounded, explicit tool allow-list, is the part that signals you're paying attention to where the field is going, not where it was two years ago.

- **COMPASS-19** — `LlmProvider` interface + Bedrock adapter (requires requesting model access in the Bedrock console first — a real step, don't skip it) + OpenRouter adapter. *Acceptance: swapping providers is a config change, not a code change; both actually return a completion.*
- **COMPASS-20** — RAG query flow: embed the question, pgvector similarity search (top-k), construct a grounded prompt, call the LLM, return an answer with cited source chunks. *Acceptance: asking about content in an uploaded doc returns an answer that quotes/cites it; asking about something not in any doc says so instead of hallucinating.*
- **COMPASS-21** — Agent tool-calling loop with an **explicit allow-list** of tools (no arbitrary code execution): `get_aws_cost_summary` (Cost Explorer, last 7 days), `get_cloudwatch_alarm_status`, `get_recent_ci_runs` (GitHub Actions API). All read-only, on purpose — document why in an ADR. *Acceptance: asking "how much have I spent on AWS this week" triggers a real tool call and a real answer, and the agent refuses/explains when asked to do something outside its tool list.*
- **COMPASS-22** — Guardrails: input validation on tool arguments, a hard cap on tool-call iterations per request (no infinite loops), logging of every tool call made (this is also your best observability story — Epic 8 builds on it).

**Grill checkpoint:** *"Why read-only tools only? Design the smallest possible write capability you'd add next, and the safeguard you'd build before you did."*

---

## Epic 6 — Frontend (CORE, ~1-2 sessions)

- **COMPASS-23** — Next.js chat + upload UI, Cognito login (Amplify UI or hand-rolled — your call, document the choice), calls the API. *Acceptance: end-to-end demo works from a browser — upload a doc, ask a question, see a cited answer.*
- **COMPASS-24** — Deploy via CDK: S3 + CloudFront (OAC, not a public bucket), cache invalidation wired into CI on deploy. *Acceptance: a code change is visible at the CloudFront URL within a normal CI run, without a manual invalidation step.*

---

## Epic 7 — CI/CD Hardening (CORE, ~2 sessions)

*Why it matters:* this is the part of the repo that proves you can operate a system, not just build one. The workflow shells are already in `.github/workflows/` — this epic is about making them real.

- **COMPASS-25** — PR checks: lint, typecheck, unit tests, `npm audit`, Trivy image scan, `tfsec`/`checkov` on Terraform, `cdk synth` diff posted as a PR comment. *Acceptance: a PR that introduces a known-vulnerable dependency or an open security group fails CI, visibly, with a comment explaining why.*
- **COMPASS-26** — Build & push: on merge to `main`, build `api`/`agent-tools` images, tag with the git SHA, push to ECR.
- **COMPASS-27** — Deploy to `dev` automatically on merge; promotion to `prod` requires a manual approval gate (GitHub Environments). *Acceptance: merging to main updates dev within minutes, unattended; prod never changes without an explicit click.*
- **COMPASS-28** — Post-deploy smoke test: a small script that hits the health endpoint and one real RAG query after every deploy, fails the pipeline (and should trigger rollback — stretch) if it fails.

**Grill checkpoint:** *"Your prod deploy just failed the smoke test. What's your rollback, and how long does it take? Don't just say 'kubectl rollout undo' — what does that actually do underneath?"*

---

## Epic 8 — Observability & Security Hardening (STRETCH for tracing, CORE for the rest, ~2 sessions)

- **COMPASS-29** *(CORE)* — Structured JSON logging everywhere, CloudWatch Log Groups per service with sane retention, a dashboard showing request rate/error rate/latency for the `api` service and the ingestion pipeline. *Acceptance: you can answer "how many requests failed in the last hour and why" from the dashboard alone, no log-grepping.*
- **COMPASS-30** *(CORE)* — Alarms → SNS for the failure modes that matter (DLQ depth > 0, error rate spike, EKS node not ready), not vanity metrics.
- **COMPASS-31** *(STRETCH)* — Distributed tracing: an OpenTelemetry Collector on EKS (or X-Ray SDK directly) propagating one trace ID from API Gateway through the `api` and `agent-tools` services and into the async Lambda chain. *Acceptance: pick one real request, find its full trace, end to end, in under 60 seconds.*
- **COMPASS-32** *(CORE)* — WAF on CloudFront and API Gateway: rate limiting + a managed rule group (e.g. common OWASP rules). *Acceptance: a basic rate-limit test (many rapid requests from one IP) actually gets throttled.*
- **COMPASS-33** *(CORE)* — IAM least-privilege audit: go back through every role created and confirm it's scoped to exactly what it needs, nothing wildcarded out of laziness. Document any exceptions and why.

**Grill checkpoint:** *"Show me the trace for the slowest request your system has served. What's actually slow, and is it the thing you assumed?"*

---

## Epic 9 — Docs, Diagrams, Portfolio Polish, Teardown (CORE, ~1-2 sessions)

*Why it matters: an interviewer spends 90 seconds on your README before deciding whether to look further. This epic is what turns "a repo" into "a portfolio piece."*

- **COMPASS-34** — `docs/SCALING.md`: a specific, concrete answer to "how would this break at 100x traffic and what would you change first" — written about this system, not generic advice. This is one of the highest-leverage documents in the whole repo for interviews.
- **COMPASS-35** — `docs/runbooks/`: deploy, rollback, incident response, and — critically — `teardown.md` walking through `scripts/teardown.sh` and confirming nothing billable survives it.
- **COMPASS-36** — A 60–90 second demo recording (screen capture) embedded/linked in the README — interviewers who won't run your code will watch 90 seconds of it.
- **COMPASS-37** — Final cost report: what did the two weeks actually cost against the $100 credit, broken down by service. This single artifact is a great answer to "how do you think about cloud cost" in an interview.
- **COMPASS-38** — Run `scripts/teardown.sh` for real. Confirm in the AWS console (not just the script's exit code) that the EKS cluster, NAT instance, RDS instance, and NAT/interface endpoints are gone.

---

## Forward-looking AI engineering — what's already baked in, and what to read up on

This project already demonstrates the trend that matters most right now: **agentic tool-calling with explicit, bounded, read-only tools**, not an open-ended "let the model run shell commands" demo. That's the right instinct to be able to talk about in an interview. A few adjacent trends worth being conversational about even if you don't build them here — read up during a low-energy session rather than coding:

- **Evals** — how you'd measure whether a prompt/RAG change actually improved answer quality, not just "it looks better to me." Even a tiny golden-set eval (10 questions with known-good answers, scored automatically) is a strong thing to mention you considered.
- **Prompt/context versioning** — treating prompts as code (versioned, tested, reviewed), not as strings buried in a handler.
- **MCP (Model Context Protocol)** — the emerging standard for exposing tools to agents in a provider-agnostic way; worth knowing what problem it solves even if this project's tool-calling is hand-rolled.
- **Guardrails/output validation** — structured output validation (e.g. JSON schema enforcement on tool-call arguments, which COMPASS-22 already does a version of) as a category, separate from prompt engineering.

---

## Definition of done for the whole program

You should be able to, live, in an interview: draw the architecture diagram from memory; explain every ADR's trade-off in one sentence each; demo the app end to end; show one real trace through the system; and answer "what would you change if this had to handle 100x traffic tomorrow" with specifics from `docs/SCALING.md`. If you can do all five, this project has done its job — the code itself is almost secondary to that.
