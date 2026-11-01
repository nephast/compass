# syntax=docker/dockerfile:1.7
# Build context is the REPO ROOT (npm workspaces: the service depends on
# packages/*). Build with:  docker build -f apps/agent-tools/Dockerfile .

# --- build: install the workspace, bundle to one file -----------------------
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/agent-tools ./apps/agent-tools
# --workspace scopes the install to this service and what it depends on, so
# the frontend's and CDK's dependency trees never enter this image's build.
# The optional `extra_ca` secret is for building behind a TLS-intercepting proxy
# (docker build --secret id=extra_ca,src=<pem>). Absent in CI, where it is a
# no-op; a secret mount never lands in an image layer.
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) \
    npm ci --workspace @compass/agent-tools --include-workspace-root=false --ignore-scripts
RUN npm run build --workspace @compass/agent-tools

# --- runtime: one JS file, no npm, no shell tooling beyond busybox -----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    SERVICE_NAME=agent-tools
WORKDIR /app
# Patch the base image's OS packages at build time (Trivy gates fixable
# HIGH/CRITICAL findings, COMPASS-25), and drop npm and corepack, which are not
# needed at runtime and carry their own CVE surface.
RUN --mount=type=secret,id=extra_ca,required=false \
    SSL_CERT_FILE=$([ -f /run/secrets/extra_ca ] && echo /run/secrets/extra_ca || echo /etc/ssl/certs/ca-certificates.crt) \
    apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /repo/apps/agent-tools/dist/main.mjs ./main.mjs
# The image's built-in unprivileged user (uid 1000). The Deployment also sets
# runAsNonRoot, so a future base image defaulting to root fails to start
# instead of silently running as root.
USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
