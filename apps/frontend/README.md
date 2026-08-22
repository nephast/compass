# apps/frontend

Next.js chat + upload UI. Talks to the API via API Gateway, auth via Cognito.

**Ticket:** COMPASS-23, COMPASS-24 (see `docs/PROGRAM.md`)

## TODO

- [ ] `npx create-next-app@latest .` (TypeScript, App Router)
- [ ] Cognito auth (Amplify UI or hand-rolled — pick one, note the choice in an ADR if it's non-obvious)
- [ ] Upload flow: request presigned URL from API → PUT directly to S3 → show ingestion status
- [ ] Chat flow: send question → stream/display answer with cited source chunks
- [ ] Deployed via `infra/cdk` (S3 + CloudFront, OAC) — build output goes to a static export
