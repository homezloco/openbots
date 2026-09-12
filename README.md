# OpenBots

Watch your agents think on a live canvas, steer them mid-run by dragging
an edge, and trust them with real write access.

OpenBots is open-source, self-hosted, and model-agnostic: connect any
provider — Anthropic, OpenAI, xAI, OpenRouter, or any OpenAI-compatible
endpoint (including local models via Ollama) — and design agent
hierarchies on a live canvas with drag-and-drop routing, instead of a
black-box "just describe your bot" flow.

<p align="center">
  <img src="docs/assets/openbots-reroute.gif" width="720" alt="Dragging an edge on the Hierarchy canvas mid-run so the next hop goes to Billing instead of Support">
</p>

Mid-run reroute: drag an edge while a hop is still generating, and the
next hop follows the new target (`live` mode). The in-flight model call
is never cancelled; the engine re-reads the graph after it returns.

A "bot" and a "graph" are the same thing: a single-node graph shows up on
the Dashboard as a chat bot with persistent conversation memory; add a
second agent and it becomes a real pipeline you view on the Hierarchy
canvas. Describe a new agent in plain English ("summarizes support
tickets") and a master-agent flow fills in its role, system prompt, and
model for you — or configure everything by hand.

Graphs don't have to stay self-contained, either: one graph can dispatch
work into another graph you own, check back on how that went, or be
granted full read/edit access to restructure it outright — so a single
"portfolio" agent can run an entire fleet of teams, each with agents that
actually read and write real code, push it, and open a PR, all visible
as one live hierarchy.

<p align="center">
  <img src="docs/assets/openbots-gateway-clickthrough.gif" width="720" alt="Clicking a dashed gateway node on the Hierarchy canvas to open that team's own canvas">
</p>

That cross-graph reach renders as dashed "gateway" nodes right on the
canvas — click one and you're on that team's own canvas, not a modal or
a config panel. Graphs nest instead of sprawling: a portfolio of teams
stays readable as separate, clickable hierarchies rather than one
unreadable mega-graph. On the Dashboard, **Try the agency demo** button
sets up a fictional portfolio with exactly this shape so you can click
through it yourself before wiring up your own.

See [`PLAN.md`](./PLAN.md) for scope, phase status, and an honest running
list of what's verified vs. still untested; [`CLAUDE.md`](./CLAUDE.md)
for architecture notes aimed at an AI pair programmer; and
[`docs/`](./docs) for how the orchestration engine and provider adapters
work in depth.

## Why OpenBots

- **n8n** lets you watch a workflow run, but you can't steer it mid-run —
  edits apply to the next execution, not the one in flight.
- **CrewAI / LangGraph** are code libraries: you write Python, you don't
  get a live canvas to watch or drag edges on while agents are running.
- **Closed bot platforms** lock you to one hosted vendor and one model.

OpenBots is self-hosted (your Postgres, your Redis, your containers) and
model-agnostic BYOK — bring your own key for any supported provider, or
run fully local via Ollama with no API key and no data leaving your
machine. The live canvas and mid-run rerouting aren't a bolt-on view;
they're how the orchestration engine actually works — see
`docs/orchestration.md`.

## Safety

Giving agents real write access is the point, so it's worth being
specific about what's actually enforced:

- **Writes are isolated.** The first write in a run creates a fresh git
  worktree on its own branch — never your real checkout. Commits happen
  automatically per hop, on that isolated branch only.
- **Pushes and PRs require a literal command.** `/push` and `/pr` are
  matched against the raw text you type by exact regex, *before* any
  model or orchestration involvement — never an LLM's judgment call, and
  never triggerable by anything an agent read (a file, a tool result).
- **File access is dual-gated.** A node's configured read or write root
  must also fall inside a separate, operator-controlled allowlist
  (`ALLOWED_FILE_ACCESS_ROOTS` / `ALLOWED_FILE_WRITE_ROOTS`) — one alone
  never grants access. Empty allowlists mean no agent can touch the
  filesystem at all, however it's configured.
- **Credentials are encrypted and never returned.** Stored provider keys
  and account secrets (GitHub PAT/SSH key, metrics logins) are AES-256-GCM
  encrypted at rest; no API response ever includes the plaintext.

None of this is a promise that agents are infallible — it's what limits
the blast radius when they're wrong.

## What's here

- **Hierarchy canvas** — create agents (manually or via natural-language quick-add), wire routing by dragging between nodes, drag an existing edge to reroute it — even mid-run, if the run was started in `live` mode. Explicit, auto (name + description matched), and consensus (fan-out/aggregate) routing all render on the same graph, with live node-pulse/edge-signal animation while a run is actually executing. Hybrid supervisors can name one specialist, start with `ALL` to fan out, `UNKNOWN` when they can't pick, or `DONE` when they already have the answer.
- **Dashboard** — a roster of your bots (graphs), each with real multi-turn conversation memory; a multi-agent "team" gets the same one-screen chat experience as a single bot, with the live canvas rendered right alongside it.
- **Per-agent conversation history** — click any node on the canvas to see every run it's ever been part of, distinguishing direct messages from ones another agent routed to it.
- **Agents that write real code** — file read/write tools scoped to one directory per agent; every write lands on an isolated git worktree branch, never your real checkout, auto-committed per hop. `search_knowledge` searches that same folder (lightweight RAG, not a vector database). Nothing is ever pushed without you typing the literal `/push` command yourself (HTTPS+PAT or SSH) — deliberately never an LLM's judgment call — and `/pr` opens a real pull request once it's pushed.
- **A GitHub tab** — every branch an agent has committed to, grouped with push status, live PR status fetched from GitHub, one-click PR creation, and a real diff viewer, right on the canvas.
- **Scheduled runs** — any graph can run itself on a recurring cron schedule (BullMQ job schedulers, survives a restart), with per-schedule run history.
- **Cross-graph orchestration** — one graph can fire-and-forget dispatch work into another graph you own (`dispatch_to_graph`), check back later on how that run went (`check_dispatch_status`), or be granted full read/edit access to create, update, and delete another graph's agents and routing (`manage_target_graphs`) — held to the exact same file-access and ownership rules a human editing it directly would be. This cross-graph reach renders live on the canvas as connected "gateway" nodes you can click through to that graph's own full editor.
- **MCP client** — a node with `"mcp"` in its tools and a configured server list can call tools on remote Streamable HTTP (or SSE) MCP servers you allowlist. Configure it on the agent's settings panel (Discover tools, then tick an allowlist). The worker never spawns stdio processes and never loads user code. Operator fence: `ALLOWED_MCP_SERVERS` (empty-deny). See `docs/adapters.md`.
- **Real external data, not just chat-supplied numbers** — `business_metrics` for conversion/revenue/traffic from sources you add at `/settings` (one `metrics_<slug>` login per site/app), and a local hardware-telemetry tool for a sibling monitoring app, both strictly read-only. Credential gaps are `/settings` work, not something a file-writing specialist can "fix" by editing a repo.
- **Pre-approved remote commands** — `run_remote_command` over SSH, only to hosts in `ALLOWED_SSH_HOSTS`, only the command labels a human pinned on that node.
- **Reviewer/tier warnings** — a soft, self-declared-tier check that flags when a reviewer agent is a weaker tier than the work it's reviewing.
- **Multi-user auth** — signup/login with scrypt-hashed passwords and signed session cookies; every graph is owned and access-controlled (reads included).
- **Usage/cost tracking, cross-provider fallback chains, encrypted per-agent and per-account credentials, a small built-in tool registry** — see `docs/adapters.md`.
- **Templates** — save any graph as a reusable, self-contained template (file-access, MCP servers, and dispatch targets are dropped on copy); instantiate it into a fresh graph with new node/edge ids.
- **Run replay/audit** — every routing edit and every run's full hop-by-hop trail is persisted. Optionally export those hops as OpenTelemetry traces (`OTEL_EXPORTER_OTLP_ENDPOINT` on the worker) into Jaeger, Grafana Tempo, or Honeycomb. **Fork from here** on a hop starts a new run from that checkpoint (original trail unchanged).

## Stack

TypeScript monorepo (pnpm + Turborepo): Next.js + React Flow frontend,
Fastify orchestration API + BullMQ worker, Postgres (source of truth),
Redis (job queue + pub/sub for live run status).

```
apps/
  web/   Next.js frontend — hierarchy canvas, dashboard, runs, templates, settings
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
# fill in at least one model key (ANTHROPIC_API_KEY, OPENAI_API_KEY,
# XAI_API_KEY, OPENROUTER_API_KEY, or OPENAI_COMPATIBLE_BASE_URL), and
# generate the two secrets:
#   openssl rand -hex 32   ->  SESSION_SECRET
#   openssl rand -hex 32   ->  CREDENTIALS_ENCRYPTION_KEY

docker compose up postgres redis -d --wait
pnpm dev   # web + api + worker. The API applies migrations on boot.
```

`.env.example` points Redis at `localhost:6380` because compose publishes that host port (to avoid clashing with a local Redis on 6379). Inside compose, api/worker still talk to `redis:6379`.

The API process only *enqueues* hops; the worker *runs* them. `pnpm dev` starts both. Without a worker, runs stay `pending` forever.

Or run the backend containerized: `docker compose up postgres redis api worker -d`. The API container migrates on start and the worker waits until `/health` is up. Compose also starts a tiny `mcp-echo` fixture used by the e2e suite (`http://mcp-echo:3930/mcp`); add that prefix to `ALLOWED_MCP_SERVERS` if you want MCP locally. The `web` service can also be built with `docker compose up --build web`; if a sandboxed environment's registry connection is flaky on large packages (`next`, `@next/swc-*`), `pnpm --filter @openbots/web build && pnpm --filter @openbots/web start` runs it locally against the dockerized API just as well.

Sign up at `/login`. On the Dashboard, click **Try the live-reroute demo** — that is the graph in the GIF above. Leave **Live** checked, start a run, drag the Router's outgoing edge onto Billing while Router is still generating. **Try the agency demo** creates a fictional Acme Portfolio whose dashed gateway nodes open Payments and Platform team graphs (Lead + Backend / Frontend / Reviewer). Or describe a bot with "+ New bot" (uses whichever model key you set, not just Anthropic).

Account-level secrets (GitHub PAT / SSH key for `/push` and `/pr`, plus `metrics_<slug>` logins) live at `/settings`. They are stored encrypted and never returned in API responses.

See `CLAUDE.md` for the full command reference and `pnpm --filter @openbots/api test:e2e` for the real end-to-end test suite (real model calls, no mocks). `pnpm --filter @openbots/api db:migrate` is still there if you want to apply migrations without starting the API; `db:generate` is only for after you edit `apps/api/src/db/schema.ts`.

## License

Apache License 2.0, plus one narrow addition: you can self-host, modify,
fork, and run OpenBots for your own organization (any size) or on behalf
of one consulting client at a time, entirely free — you just can't stand
up your own hosted multi-tenant "OpenBots as a service" for third parties
without a commercial agreement. See [`LICENSE`](./LICENSE) for the exact
terms (GitHub's detector may show this as "Other" rather than
"Apache-2.0" because of that addition — that's expected).
