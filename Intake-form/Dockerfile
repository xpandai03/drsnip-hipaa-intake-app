# syntax=docker/dockerfile:1
#
# DrSnip intake form — Fly.io image (Phase 1 scaffold).
#
# Stage 1 builds the Vite SPA, compiles the workspace libs, and bundles the
# Hono API server (api-server/index.ts) into a single self-contained
# dist/server.cjs via esbuild. Stage 2 is a minimal runtime carrying only
# Node, that bundle, and the built static SPA — no node_modules.

# ---- Stage 1: build --------------------------------------------------------
FROM node:20-alpine AS builder
RUN npm install -g pnpm@10.33.4
WORKDIR /app

# Copy the whole workspace, then install. --frozen-lockfile=false lets the
# lockfile pick up the linux-platform native binaries (dev machines are macOS).
COPY . .
RUN pnpm install --frozen-lockfile=false

# `pnpm run build` = typecheck + per-package build (SPA + libs) + build:server
# (the esbuild bundle of the Hono server).
RUN pnpm run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# The server bundle is self-contained; only the built SPA must travel with it.
# STATIC_ROOT in api-server/index.ts resolves to this same relative path.
COPY --from=builder /app/dist/server.cjs ./dist/server.cjs
COPY --from=builder /app/artifacts/intake-form/dist/public ./artifacts/intake-form/dist/public

EXPOSE 8080
CMD ["node", "dist/server.cjs"]
