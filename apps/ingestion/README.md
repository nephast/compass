# apps/ingestion

Lambda handlers for the serverless ingestion pipeline (S3 → EventBridge → Step
Functions → SQS → Lambda chain). See `docs/ARCHITECTURE.md` for the full flow.

**Tickets:** COMPASS-9 through COMPASS-12 (see `docs/PROGRAM.md`)

## TODO

- [ ] `presign-upload/` — generates a presigned S3 PUT URL, behind API Gateway
- [ ] `chunk/` — splits a document into overlapping chunks (pick a chunk size/overlap deliberately, document why)
- [ ] `embed/` — calls the `LlmProvider` embeddings endpoint (Bedrock Titan Embeddings or OpenRouter equivalent)
- [ ] `store/` — writes chunks + embeddings to pgvector, **idempotently** (COMPASS-12 — re-processing the same file/message must not duplicate rows)
- [ ] Step Functions state machine definition (CDK) wiring chunk → embed → store, with a DLQ and redrive policy on the SQS queue between chunk and embed
- [ ] Unit tests runnable against LocalStack, no real AWS calls needed for the inner loop
