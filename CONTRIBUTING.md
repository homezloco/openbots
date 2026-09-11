# Contributing to OpenBots

Thanks for your interest in contributing! OpenBots is early and feedback,
bug reports, and pull requests are all welcome.

## Getting set up

```bash
corepack enable && pnpm install
cp .env.example .env   # fill in a model key + generate the two secrets

docker compose up postgres redis -d
pnpm dev               # web + api + worker
```

See `CLAUDE.md` for the full command reference and `PLAN.md` for an
honest list of what's verified vs. still untested — that's the best
place to find things that need help.

## Before you send a PR

```bash
pnpm typecheck
pnpm lint
pnpm build
```

If your change touches routing, credentials, providers, or the
write/push/schedule paths, add a case to `apps/api/e2e/run.ts` — the
real end-to-end suite. It needs a running stack and a real
`ANTHROPIC_API_KEY` (it makes real, billed API calls):

```bash
docker compose up postgres redis api worker -d --build
pnpm --filter @openbots/api test:e2e
```

## Conventions worth knowing

- `packages/graph-schema` (zod) is the source of truth for the data
  model; `apps/api/src/db/schema.ts` is a hand-maintained Drizzle
  mirror. Changing one means updating the other, then
  `pnpm --filter @openbots/api db:generate`.
- Any route returning a node or graph must go through the existing
  mappers (`nodeRowToAgentNode()`, `loadLiveGraph()`) — never return a
  raw DB row.
- The orchestrator plans one hop at a time and re-reads the graph
  between hops. That's what makes mid-run rerouting work — keep it
  that way. See `docs/orchestration.md`.
- `/push` and `/pr` are intercepted by exact regex before any model
  involvement, deliberately. Never move that check later in the
  pipeline.
- Don't add comments unless they're needed, and match the surrounding
  style.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened.
Run logs and hop trails (`/runs`) are the most useful things to
attach.

## Security issues

Please don't open a public issue — see `SECURITY.md`.
