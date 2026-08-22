# apps/api

The core API service. Runs on EKS (not Lambda — see ADR-0003). Handles auth-gated
requests from the frontend: presigned upload URLs, RAG queries (delegates the
actual LLM/tool-calling loop to `apps/agent-tools`), ingestion status.

**Tickets:** COMPASS-17, COMPASS-18, COMPASS-20 (see `docs/PROGRAM.md`)

## TODO

- [ ] Fastify (or Express/Hono — pick one, it's a fair ADR-worthy choice) TypeScript service
- [ ] `/healthz` — used by k8s readiness/liveness probes, keep it cheap (no DB call)
- [ ] `/documents/upload-url` — presigned S3 PUT URL
- [ ] `/query` — RAG flow: embed question → pgvector similarity search → prompt → LLM → cited answer
- [ ] `Dockerfile` — multi-stage build, non-root user, minimal base image
- [ ] `k8s/` manifests or Helm chart: Deployment, Service, HPA, resource requests/limits, probes
- [ ] Structured JSON logging (COMPASS-29) and trace propagation (COMPASS-31) from day one — much harder to retrofit
