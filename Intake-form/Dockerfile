# syntax=docker/dockerfile:1
#
# DrSnip intake form — Fly.io image.
#
# Stage 1 builds the Vite SPA, compiles the workspace libs, and bundles the
# Hono API server (api-server/index.ts) into a single self-contained
# dist/server.cjs via esbuild. Stage 2 is a minimal runtime carrying only
# Node, that bundle, and the built static SPA — no node_modules.
#
# Base is node:20-slim (Debian / glibc) — NOT alpine. The pnpm platform
# overrides in pnpm-workspace.yaml keep the linux-x64-GNU native binaries
# (lightningcss, rollup, @tailwindcss/oxide) but strip the musl variants, so
# an alpine/musl image would have no usable native binaries for the build.

# ---- Stage 1: build --------------------------------------------------------
FROM node:20-slim AS builder
RUN npm install -g pnpm@10.33.4
WORKDIR /app

# Copy the whole workspace, then install. --frozen-lockfile=false lets the
# lockfile pick up the linux-platform native binaries (dev machines are macOS).
COPY . .
RUN pnpm install --frozen-lockfile=false

# Compile the @workspace/db library up front, as its own step, so its dist/
# (and the .d.ts the api typecheck + esbuild bundle resolve) exist before
# `pnpm run build` runs. `--force` ignores any stale incremental tsbuildinfo
# (a plain `tsc --build` was exiting 0 without emitting); the `test` makes a
# missing emit fail loudly right here.
RUN rm -rf lib/db/dist \
 && pnpm --filter @workspace/db exec tsc --build --force \
 && test -f lib/db/dist/index.d.ts \
 && echo "lib/db compiled OK"

# `pnpm run build` = typecheck + per-package build (SPA) + build:server
# (the esbuild bundle of the Hono server).
RUN pnpm run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# All three bundles are self-contained; only the built SPA must travel with them.
# STATIC_ROOT in api-server/index.ts resolves to this same relative path.
# migrate.cjs + seed-viewer.cjs are the Fly release_command chain (see fly.toml).
COPY --from=builder /app/dist/server.cjs ./dist/server.cjs
COPY --from=builder /app/dist/migrate.cjs ./dist/migrate.cjs
COPY --from=builder /app/dist/seed-viewer.cjs ./dist/seed-viewer.cjs
COPY --from=builder /app/artifacts/intake-form/dist/public ./artifacts/intake-form/dist/public

EXPOSE 8080
CMD ["node", "dist/server.cjs"]
