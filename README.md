# Compass

**Compass** is an AI-powered knowledge assistant with agentic ops capabilities — upload documents, ask questions grounded in them (RAG), and let an agent take bounded actions against your own AWS account and CI pipeline (check costs, read alarms, summarize deploys) via tool calling.

It exists as a portfolio project. The point is not the chatbot — it's the platform underneath it: an event-driven serverless ingestion pipeline, a containerized service running on a real EKS cluster, dual IaC (CDK + Terraform), a trunk-based CI/CD pipeline with proper gates, distributed tracing, and documented security/cost decisions. Everything here should be defensible in a system design interview, line by line.

See [`docs/PROGRAM.md`](docs/PROGRAM.md) for the 2-week build curriculum this repo was scaffolded for, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it fits together.

## Why this project

Built to demonstrate, in one coherent system:

- **Serverless event-driven patterns** — S3 → EventBridge → Step Functions → SQS → Lambda, with DLQs and idempotency, not just a single Lambda behind API Gateway.
- **Containers & Kubernetes on AWS** — a real EKS cluster (not a toy), IRSA, HPA, network policies, resource requests/limits — the parts of K8s that only show up "at scale."
- **Forward-leaning AI engineering** — RAG (chunking, embeddings, vector search) plus agentic tool-calling, with the LLM provider abstracted behind an interface (Bedrock + OpenRouter) rather than hard-coded to one vendor.
- **Infrastructure as Code, twice, on purpose** — Terraform for the platform layer (VPC, EKS, account guardrails) and CDK/TypeScript for application infra, mirroring how platform and product teams typically split ownership.
- **Real CI/CD** — trunk-based development, small PRs, conventional commits, automated plan/diff on PRs, gated promotion to a second environment, automated smoke tests post-deploy.
- **Security and cost as first-class, not afterthoughts** — least-privilege IAM, Cognito-authenticated API, secrets never in code, AWS Budgets with alarms, and a teardown script so a portfolio project doesn't quietly become a monthly bill.

## Status

This repo is a **scaffold**, not a finished build. Stacks, workflows, and services are stubbed with `TODO`s and acceptance criteria — see `docs/PROGRAM.md`. That's deliberate: you write the implementation, Claude reviews it and grills you on the trade-offs, same as a senior pairing with you rather than doing it for you.

## Repo layout

```
compass/
├── apps/
│   ├── frontend/       Next.js chat + upload UI (S3 + CloudFront)
│   ├── api/            Core API service — runs on EKS (Fastify/TS)
│   ├── ingestion/       Lambda handlers — chunk, embed, store (serverless)
│   └── agent-tools/    Agent tool implementations (cost, alarms, CI status)
├── infra/
│   ├── cdk/            App infra: S3, CloudFront, API Gateway, Lambda, Step Functions, Cognito
│   └── terraform/      Platform infra: VPC, EKS cluster, ECR, IAM boundaries, budgets
├── docs/
│   ├── PROGRAM.md      The 2-week curriculum (epics, tickets, acceptance criteria)
│   ├── ARCHITECTURE.md Full system design + diagram
│   ├── adrs/           Architecture Decision Records
│   ├── runbooks/       Deploy, rollback, incident, teardown runbooks
│   └── diagrams/
├── scripts/            setup-aws-guardrails.sh, teardown.sh, local dev helpers
└── .github/workflows/  CI/CD pipelines
```

## Local development

```bash
cp .env.example .env        # fill in OpenRouter key, etc. — never commit this file
docker compose up -d        # LocalStack + Postgres/pgvector for local dev
npm install
npm run dev
```

See `docs/runbooks/local-development.md` (write this as part of Epic 0) for the full loop.

## Cost guardrails — read before deploying anything

This runs on a **new AWS account** using free-tier + a **$100 credit budget**. Before you deploy a single stack:

1. Run `scripts/setup-aws-guardrails.sh` (or follow `docs/runbooks/aws-account-setup.md`) to enable MFA, set up AWS Budgets with alerts at $10/$25/$50/$90, and enable CloudTrail.
2. Know your teardown command before you need it: `scripts/teardown.sh`. Run it at the end of every session where you don't need resources running overnight, and definitely at the end of the two weeks.
3. EKS control plane costs money **the moment it exists**, whether or not you deploy anything to it — budget for that.

## License

MIT — this is a learning/portfolio project, use it however's useful to you.

testing
