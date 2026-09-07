# syntax=docker/dockerfile:1.7
FROM node:22-slim AS base
RUN corepack enable
RUN pnpm config set store-dir /pnpm-store
WORKDIR /repo

# Every workspace package.json must be present for pnpm to reconcile the
# lockfile, but --filter below means only the api's own dependency tree
# (not web's Next.js/React) actually gets fetched here. The cache mount
# persists pnpm's package store across builds/retries so a flaky registry
# fetch doesn't have to restart from zero.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/graph-schema/package.json packages/graph-schema/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter "@openbots/api..."

FROM deps AS build
COPY . .
RUN pnpm --filter @openbots/graph-schema --filter @openbots/providers --filter @openbots/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
