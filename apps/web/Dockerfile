# syntax=docker/dockerfile:1.7
FROM node:22-slim AS base
RUN corepack enable
RUN pnpm config set store-dir /pnpm-store
# Large tarballs (next, @next/swc-*) have repeatedly hit transient
# registry-fetch failures (ERR_PNPM_TARBALL_FETCH_TARBALL) in sandboxed
# build environments — not a dependency problem. Give pnpm a real retry
# budget and cap concurrency instead of retrying the whole build by hand.
RUN pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 20000 && \
    pnpm config set fetch-retry-maxtimeout 120000 && \
    pnpm config set network-concurrency 4
WORKDIR /repo

# Every workspace package.json must be present for pnpm to reconcile the
# lockfile, but --filter below means only web's own dependency tree
# (not api's Fastify/BullMQ/Drizzle) actually gets fetched here. The cache
# mount persists pnpm's package store across builds/retries so a flaky
# registry fetch doesn't have to restart from zero.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/graph-schema/package.json packages/graph-schema/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Cache-mount id carries an s/<service-id>- prefix for Railway's Metal
# builder (see the same note in apps/api/Dockerfile). Harmless locally.
RUN --mount=type=cache,id=s/c21d94e9-1547-4643-84b7-6057a3d5ca83-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter "@openbots/web..."

FROM deps AS build
COPY . .
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time —
# a runtime env var (like compose's `environment:` entry) reaches only
# server code. Railway injects this build arg so the bundle points at the
# deployed api domain instead of the localhost:4000 fallback in lib/api.ts.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @openbots/graph-schema --filter @openbots/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
