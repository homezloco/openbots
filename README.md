# OpenBots

Open-source, self-hosted, model-agnostic multi-agent orchestration.
Connect any provider — Anthropic, OpenAI, xAI, OpenRouter, or any
OpenAI-compatible endpoint — and design agent hierarchies on a live
canvas with drag-and-drop routing, instead of a black-box "just describe
your bot" flow.

See [`PLAN.md`](./PLAN.md) for scope/roadmap and competitive positioning,
and [`docs/`](./docs) for how the orchestration engine and provider
adapters work.

## Stack

TypeScript monorepo (pnpm + Turborepo): Next.js + React Flow frontend,
Fastify orchestration API, Postgres (source of truth), Redis (BullMQ job
queue + pub/sub for live run status).

```
apps/
  web/   Next.js frontend — hierarchy canvas + dashboard
  api/   Fastify API + orchestration engine + BullMQ worker
packages/
  graph-schema/  Shared types + zod validation (agents, edges, runs)
  providers/     Provider adapters, built on the Vercel AI SDK
```

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env   # fill in the provider keys you plan to use

docker compose up postgres redis -d
pnpm --filter @openbots/api db:generate
pnpm --filter @openbots/api db:migrate

pnpm dev   # runs web + api in parallel via turbo
```

Or run everything containerized: `docker compose up --build`.

## Quickstart: create a graph and run it

```bash
# 1. Create a graph
curl -X POST localhost:4000/graphs -H 'content-type: application/json' \
  -d '{"name": "Support triage"}'

# 2. Add agent nodes (repeat per agent), then wire routing edges
curl -X POST localhost:4000/graphs/<graphId>/nodes -H 'content-type: application/json' \
  -d '{"name":"Triage","role":"router","provider":"anthropic","model":"claude-sonnet-5","position":{"x":0,"y":0}}'

curl -X POST localhost:4000/graphs/<graphId>/edges -H 'content-type: application/json' \
  -d '{"sourceNodeId":"<a>","targetNodeId":"<b>","kind":"explicit"}'

# 3. Set the entry node, then start a run
curl -X PATCH localhost:4000/graphs/<graphId> -H 'content-type: application/json' \
  -d '{"entryNodeId":"<a>"}'

curl -X POST localhost:4000/runs -H 'content-type: application/json' \
  -d '{"graphId":"<graphId>","input":"a customer needs a refund"}'

# 4. Watch it live
open "http://localhost:3000/hierarchy?graphId=<graphId>"
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
