# apps/frontend

Next.js (App Router) **static export**, served from a private S3 bucket through
CloudFront with OAC (COMPASS-24). One page: upload, document status, cited answers,
and an "ask about ops" mode that goes to the agent.

**Tickets:** COMPASS-23, COMPASS-24

## Auth: hand-rolled code + PKCE, not Amplify

The ticket leaves the choice open; this is the reasoning.

| | Hand-rolled (`lib/pkce.ts`) | Amplify UI |
|---|---|---|
| Size | ~150 lines, no dependency | large dependency tree, its own config format |
| Visibility | every OAuth step is in one file, tested against the RFC 7636 vector | a black box you configure |
| Features | sign in/out, refresh, CSRF `state` check | also MFA flows, social IdPs, UI components |

Sign-in uses Cognito's **managed login** page, so passwords never touch this app.
Tokens live in `sessionStorage` (survives the Cognito redirect, not a closed tab, and
is never sent automatically like a cookie). The trade-off against an httpOnly cookie
is that script on this origin could read it — which is what the CSP served by
CloudFront (`script-src 'self'`) exists to prevent. Access tokens live 15 minutes.

## Runtime config

The app fetches `/config.json` at startup. In AWS the Site stack writes it at deploy
time (API URL, Cognito ids, auth domain); locally `scripts/dev-stack.sh` copies
`public/config.local.json`. One build artefact serves every environment.

## Local

```bash
scripts/dev-stack.sh      # LocalStack + pgvector + api + agent-tools + ingestion watcher + this
open http://localhost:3000
```

Local mode uses `AUTH_MODE=dev` (type any user name) and the offline fake models.
The recorded walkthrough is `docs/demo/compass-local-demo.mp4`.
