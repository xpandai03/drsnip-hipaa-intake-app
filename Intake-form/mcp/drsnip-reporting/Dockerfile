# Read-only, aggregate-only DrSnip Reporting MCP — remote HTTP server image.
# Self-contained: this package has its own package.json + lockfile, so the
# build context is just mcp/drsnip-reporting (no monorepo install needed).
FROM node:20-alpine

WORKDIR /app

# Install only production deps against the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
# Host injects PORT; default matches the server.
EXPOSE 8787

# Remote HTTP entrypoint (bearer/OAuth-protected, read-only, aggregate-only).
# Credentials come from the host's env: DRSNIP_INTAKE_DATABASE_URL (the
# read-only PHI-free view role), MCP_AUTH_TOKEN, OAUTH_LOGIN_PASSWORD,
# OAUTH_SIGNING_SECRET.
CMD ["node", "src/http-server.js"]
