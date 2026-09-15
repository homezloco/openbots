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
# Cache-mount ids carry an s/<service-id>- prefix because Railway's Metal
# builder rejects any id not prefixed with the service's own cache key
# (env/ARG interpolation is not allowed there). Harmless locally — the id
# is just a BuildKit cache key outside Railway.
RUN --mount=type=cache,id=s/2557dda1-bdcc-4d82-9bfe-d6ad119852ff-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter "@openbots/api..."

FROM deps AS build
COPY . .
RUN pnpm --filter @openbots/graph-schema --filter @openbots/providers --filter @openbots/api build

FROM base AS runtime
ENV NODE_ENV=production
# git is a runtime dependency of the worker process, not a build-time one
# — the write_file/edit_file tools isolate every agent write inside a git
# worktree (see packages/providers/src/gitWorktree.ts) rather than ever
# touching the user's real checkout directly. openssh-client provides the
# actual `ssh` binary git shells out to for a git@/ssh:// push AND the one
# run_remote_command (orchestrator/remoteCommandTool.ts) invokes directly
# — --no-install-recommends means apt would otherwise skip it entirely
# even though git "recommends" it, silently leaving both SSH paths broken.
RUN --mount=type=cache,id=s/2557dda1-bdcc-4d82-9bfe-d6ad119852ff-apt-cache,target=/var/cache/apt --mount=type=cache,id=s/2557dda1-bdcc-4d82-9bfe-d6ad119852ff-apt-lists,target=/var/lib/apt/lists \
    apt-get update && apt-get install -y --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
