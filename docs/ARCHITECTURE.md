# Architecture

## System diagram (as built)

```mermaid
flowchart TB
    subgraph Client
        FE[Next.js static export<br/>S3 + CloudFront OAC]
    end

    subgraph Edge["Edge / Auth"]
        WAF[WAF: per-IP rate limit<br/>+ AWS managed rules]
        APIGW[API Gateway HTTP API<br/>JWT authorizer + stage throttle]
        COGNITO[Cognito: managed login<br/>code + PKCE, 15-min tokens]
    end

    subgraph Ingestion["Serverless ingestion (event-driven)"]
        S3DOCS[(S3: documents<br/>uploads/&lt;sub&gt;/...)]
        EB[EventBridge rule<br/>Object Created, uploads/ only]
        SFN[Step Functions<br/>retry + catch]
        LINGEST[Lambda: decode → chunk →<br/>embed → idempotent store]
    end

    subgraph Data["Data layer (private subnets)"]
        RDS[(RDS Postgres 17 + pgvector<br/>IAM auth, owner-scoped rows)]
    end

    subgraph Compute["EKS (private subnets)"]
        ALB[internal ALB → NodePort]
        API[api: Fastify<br/>presign · RAG · documents<br/>HPA 2–4]
        AGENT[agent-tools<br/>read-only allow-list, capped loop]
    end

    subgraph AI["LlmProvider (packages/llm)"]
        BEDROCK[Bedrock: Titan V2 embeddings,<br/>Nova Lite completions]
        OPENROUTER[OpenRouter<br/>completions / tools only]
    end

    subgraph Ops["Read-only ops surfaces"]
        COST[Cost Explorer]
        CW[CloudWatch alarms]
        GHA[GitHub Actions API]
    end

    subgraph Observability
        LOGS[JSON logs with traceId<br/>Container Insights + Logs Insights]
        DASH[Dashboard + 4 alarms → SNS]
    end

    WAF -.protects.- FE
    FE -->|PKCE sign-in| COGNITO
    FE -->|Bearer access token| APIGW
    APIGW -->|VPC Link| ALB --> API
    API -->|presigned PUT URL| FE
    FE -->|PUT, size + type signed| S3DOCS
    API --> RDS
    API --> AGENT
    API --> BEDROCK
    AGENT --> BEDROCK
    AGENT -.optional.-> OPENROUTER
    AGENT --> COST
    AGENT --> CW
    AGENT --> GHA

    S3DOCS -->|Object Created| EB --> SFN --> LINGEST --> RDS
    LINGEST --> BEDROCK

    API -.logs.-> LOGS
    AGENT -.logs.-> LOGS
    LINGEST -.logs + X-Ray.-> LOGS
    LOGS --> DASH
```

**What changed from the original design, and why:**

- **No SQS chain in ingestion.** The 29 Aug delivery cut collapsed chunk → SQS →
  embed → store into one Lambda (COMPASS-11 issue). Step Functions' retry/catch
  plays the DLQ's role, and the `ingestion-failed` alarm watches it. Putting the
  queue back is change #2 in `docs/SCALING.md`.
- **WAF covers CloudFront only.** HTTP APIs can't take a WAF web ACL; the API relies on
  stage throttling plus the JWT authorizer (ADR-0009).
- **Tracing is trace-id log correlation plus X-Ray on the async side**, not a full
  OTel collector (COMPASS-31 is STRETCH). One `traceId`, derived from the gateway's
  request id, appears in the access log and in every api and agent log line
  (`docs/runbooks/incident-response.md` §2).
- **Ownership.** Every document belongs to a Cognito `sub`. The api builds the object
  key, ingestion reads ownership back from it, and retrieval filters on it (ADR-0007).

## Why hybrid (serverless + EKS), not one or the other

Your day job is serverless-first, so the ingestion pipeline stays serverless deliberately — it's a refresher, not new ground, and event-driven ingestion (S3 event → EventBridge → Step Functions → SQS → Lambda, with a DLQ and idempotent handlers) is genuinely the right shape for bursty, asynchronous work regardless of what you're used to.

The API and agent layer run on EKS on purpose, because that's the gap: real Kubernetes-on-AWS reps — IRSA instead of instance profiles, HPA instead of Lambda concurrency, network policies instead of Lambda's implicit isolation, a Deployment's rollout behavior instead of Lambda's built-in versioning. Running a synchronous, stateful-ish, always-warm chat/agent workload on EKS also happens to be the more realistic choice for that workload shape — Lambda cold starts are a bad fit for an interactive agent loop that may call multiple tools in sequence.

## Why two IaC tools

Terraform owns the platform layer: VPC, EKS cluster, ECR, IAM permission boundaries, AWS Budgets. This layer changes rarely, benefits from Terraform's broad provider ecosystem and state-locking maturity, and mirrors how a platform/infra team usually owns this in a real org.

CDK (TypeScript) owns application infra: S3, CloudFront, API Gateway, Lambda, Step Functions, Cognito. This layer changes often as the app evolves, benefits from being in the same language as the app code (shared types, faster iteration), and mirrors how a product team usually owns this.

The seam between them (e.g., the API service needs the VPC ID and EKS OIDC provider ARN that Terraform created) is deliberately instructive — see ADR-0003 for how cross-stack references are passed (SSM Parameter Store, not hardcoded values).

## Why RDS + pgvector, not OpenSearch or a managed vector DB

See `docs/adrs/0002-vector-store-choice.md`. Short version: OpenSearch Serverless has no meaningful free tier and a non-trivial cost floor; a `db.t3.micro` Postgres instance costs ~$17/month against the credit (the account is on the post-July-2025 credit-based Free Tier plan, which has no 12-month RDS-hours offer — #53), and pgvector is a real, production-used pattern (not a toy), so this teaches a transferable skill (RDS, VPC security groups, IAM DB auth) instead of a throwaway one.

## Why an LLM provider abstraction

The agent/RAG code calls an internal `LlmProvider` interface, not the Bedrock or OpenRouter SDKs directly. Bedrock is the AWS-native default (and requires you to go through the real "request model access" workflow — a genuine AWS onboarding step worth having done). OpenRouter is wired in as a documented, swappable alternative — useful if Bedrock model access/quotas are ever a blocker, and it's a legitimate architecture pattern (ports & adapters) worth being able to explain and defend, not just decoration.

## Networking & security summary

- VPC with public subnets (ALB/NAT) and private subnets (EKS nodes, RDS). See ADR-0001 on NAT Gateway vs VPC endpoints for the cost trade-off.
- EKS nodes and the RDS instance have no public IPs. Only the ALB and CloudFront are internet-facing.
- IRSA: pods get scoped IAM roles via OIDC federation — no long-lived AWS credentials on nodes or in pods.
- API Gateway JWT authorizer validates Cognito tokens before any request reaches the VPC.
- Secrets (OpenRouter API key, any non-IAM credentials) live in Secrets Manager, referenced at runtime — never in env vars committed to the repo, never in CDK/Terraform source.
- WAF in front of CloudFront (per-IP rate limiting, managed rule groups); the HTTP API, which cannot take WAF, is protected by stage throttling and the JWT authorizer (ADR-0009).
- All data encrypted at rest (KMS) and in transit (TLS everywhere, including pod-to-pod where practical).

## Observability

*(As built: see "What changed" above and `docs/runbooks/incident-response.md`. The
paragraph below is the original target design.)*

Every request gets a trace ID at the edge (API Gateway) and it propagates through: API Gateway → EKS `api` service → EKS `agent-tools` service → (async) SQS → Lambda → RDS. X-Ray (or an OpenTelemetry Collector running as a DaemonSet on EKS, exporting to X-Ray — see Epic 8 for which you pick and why) stitches these into one trace so "show me what happened to this one request" is answerable in under a minute, not by grepping five log groups.

## What would change at real scale

Documented properly at the end of the build (Epic 9) as `docs/SCALING.md` — this is one of the strongest interview artifacts in the whole repo: a concrete, specific answer to "how would this break at 100x traffic and what would you change first," written about a system you actually built rather than recited in the abstract.
