# Runbook: local development loop (COMPASS-4)

## Setup

```bash
cp .env.example .env   # fill in values, never commit this file
docker compose up -d   # Postgres+pgvector, LocalStack (S3/SQS/EventBridge/Step Functions/Lambda/Secrets Manager)
npm install
npm run migrate         # once apps/api's migration tooling exists (COMPASS-14)
npm run dev
```

## What runs against LocalStack vs real AWS

Everything in the ingestion pipeline (S3 events, SQS, Step Functions, Lambda invocation) should be developable and testable against LocalStack — you should rarely need to deploy to real AWS just to iterate on handler logic. Real AWS is for: Bedrock (LocalStack doesn't mock it usefully — use a cheap/free OpenRouter model for local iteration instead, per the `LlmProvider` abstraction, COMPASS-19), and anything you're specifically testing end-to-end pre-deploy.

## `kubectl` access to the real EKS cluster

```bash
aws eks update-kubeconfig --name compass-dev --region <region>
kubectl get nodes
kubectl get pods -n compass
```

## Common issues

*(Fill this in as you actually hit things — a "known issues" section that's empty because you haven't built anything yet is honest; leaving it empty forever once you have built things is a missed opportunity to look organized.)*
