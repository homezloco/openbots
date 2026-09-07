# OpenBots

Open-source, self-hosted, model-agnostic multi-agent orchestration.
Connect any provider — Anthropic, OpenAI, xAI, OpenRouter, or any
OpenAI-compatible endpoint (including local models via Ollama) — and
design agent hierarchies on a live canvas with drag-and-drop routing,
instead of a black-box "just describe your bot" flow.

A "bot" and a "graph" are the same thing: a single-node graph shows up on
the Dashboard as a chat bot with persistent conversation memory; add a
second agent and it becomes a real pipeline you view on the Hierarchy
canvas. Describe a new agent in plain English ("summarizes support
tickets") and a master-agent flow fills in its role, system prompt, and
model for you — or configure everything by hand.

See [`PLAN.md`](./PLAN.md) for scope, phase status, and an honest running
list of what's verified vs. still untested; [`CLAUDE.md`](./CLAUDE.md)
for architecture notes aimed at an AI pair programmer; and
[`docs/`](./docs) for how the orchestration engine and provider adapters
work in depth.

## What's here

- **Hierarchy canvas** — create agents (manually or via natural-language quick-add), wire routing by dragging between nodes, drag an existing edge to reroute it — even mid-run, if the run was started in `live` mode. Explicit, auto (description-matched), and consensus (fan-out/aggregate) routing all render on the same graph.
- **Dashboard** — a roster of your bots (graphs), each with real multi-turn conversation memory.
- **Reviewer/tier warnings** — a soft, self-declared-tier check that flags when a reviewer agent is a weaker tier than the work it's reviewing.
- **Usage/cost tracking, cross-provider fallback chains, encrypted per-agent credentials, a small built-in tool registry** (calculator, current time, and a read-only file-access tool scoped to one directory per agent) — see `docs/adapters.md`.
- **Templates** — save any graph as a reusable, self-contained template; instantiate it into a fresh graph with new node/edge ids.
- **Run replay/audit** — every routing edit and every run's full hop-by-hop trail is persisted.

## Stack

TypeScript monorepo (pnpm + Turborepo): Next.js + React Flow frontend,
Fastify orchestration API + BullMQ worker, Postgres (source of truth),
Redis (job queue + pub/sub for live run status).

```
apps/
  web/   Next.js frontend — hierarchy canvas, dashboard, runs, templates
  api/   Fastify API + orchestration engine + BullMQ worker + e2e/ suite
packages/
  graph-schema/  Shared types + zod validation (agents, edges, runs) — the source of truth for the data model
  providers/     Provider adapters (built on the Vercel AI SDK), pricing, and the tool registry
```

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env
# fill in at least ANTHROPIC_API_KEY, and generate the two secrets:
#   openssl rand -hex 32   ->  SESSION_SECRET
#   openssl rand -hex 32   ->  CREDENTIALS_ENCRYPTION_KEY

docker compose up postgres redis -d
pnpm --filter @openbots/api db:generate
pnpm --filter @openbots/api db:migrate

pnpm dev   # runs web + api in parallel via turbo
```

Or run the backend containerized: `docker compose up postgres redis api worker -d`. The `web` service can also be built with `docker compose up --build web`, though in some sandboxed environments its build has hit npm-registry flakiness on large packages (`next`, `@next/swc-*`) — if that happens, `pnpm --filter @openbots/web build && pnpm --filter @openbots/web start` runs it locally against the dockerized API just as well.

Sign up your first user at `/login`, then use "New graph" (or Dashboard's "+ New bot") to get started — no API calls needed for normal use. See `CLAUDE.md` for the full command reference and `pnpm --filter @openbots/api test:e2e` for the real end-to-end test suite, which is the fastest way to confirm a fresh setup actually works end to end (it runs real model calls, no mocks).

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
