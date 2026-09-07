# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenBots: an open-source, self-hosted, model-agnostic multi-agent orchestration platform. The differentiator is a live, editable canvas of the agent hierarchy/routing — drag an edge to reroute, even while a run is executing. See `PLAN.md` for full scope, phase status, and a running "known gaps" list — check it before assuming something is finished. `docs/orchestration.md` and `docs/adapters.md` cover the two trickiest subsystems in depth.

## Commands

```bash
corepack enable && pnpm install        # first-time setup

pnpm dev                               # web + api dev servers via turbo
pnpm build / pnpm typecheck / pnpm lint  # across all packages
pnpm --filter @openbots/api typecheck    # single package
pnpm --filter @openbots/web typecheck

pnpm --filter @openbots/api db:generate  # after editing apps/api/src/db/schema.ts
pnpm --filter @openbots/api db:migrate   # apply pending migrations

docker compose up postgres redis -d      # local Postgres + Redis
docker compose up api worker -d --force-recreate  # after backend changes, rebuild first:
docker compose build api                 # api and worker share one image (see docker-compose.yml)

pnpm --filter @openbots/api test:e2e     # real e2e suite — see "Testing" below
```

There is no unit test suite — `pnpm test` at the root is a no-op (no package defines a `test` script; only `apps/api` has `test:e2e`).

### Running the web app

The containerized `web` service has never successfully built in some sandboxed dev environments (a persistent npm-registry network flakiness fetching large tarballs like `next`/`@next/swc-*`, not a code problem — `docker compose build api` is unaffected since the api image doesn't pull those packages). If `docker compose build web` fails repeatedly with `ERR_PNPM_TARBALL_FETCH_TARBALL`, fall back to running it locally instead of fighting the network:

```bash
pnpm --filter @openbots/web build
pnpm --filter @openbots/web start   # serves on :3000, talks to the dockerized api on :4000
```

### Testing

`apps/api/e2e/run.ts` is a real end-to-end suite: it makes actual HTTP calls (including real Anthropic API calls) against a running stack — no mocks. It requires `docker compose up` (postgres, redis, api, worker) already running with a real `ANTHROPIC_API_KEY` in `.env`. Run it with `pnpm --filter @openbots/api test:e2e` (or `E2E_BASE_URL=... pnpm --filter @openbots/api test:e2e` against a different host). It signs up a fresh throwaway user each run and covers: explicit/auto/consensus routing, the reviewer/tier warning, usage tracking, the file-access tool (including a blocked path-traversal attempt), templates, encrypted credential storage, fallback-chain classification, and — the trickiest one — genuine mid-run rerouting. If you add a feature that involves routing, credentials, or providers, add a case here rather than trusting manual curl checks; this suite has caught real bugs manual testing missed (see PLAN.md).

## Architecture

TypeScript pnpm/Turborepo monorepo. `apps/web` (Next.js + React Flow) and `apps/api` (Fastify + BullMQ worker) both depend on `packages/graph-schema` (zod types, the single source of truth for the data model) and `packages/providers` (model-provider adapters built on the Vercel AI SDK). `apps/api/src/db/schema.ts` (Drizzle) is a hand-maintained mirror of `graph-schema` — there is no codegen link between them; changing one means manually updating the other.

### The orchestration engine never plans a run ahead of time

`apps/api/src/orchestrator/engine.ts::dispatchHop()` dispatches exactly one node, then calls `resolve.ts::resolveNextHop()` fresh — reading whatever the graph looks like *at that moment* — and enqueues one BullMQ job for the next hop if there is one. This is the entire mechanism behind drag-and-drop rerouting (editing an edge is just a row update; it's picked up on the affected run's next hop) and it means there is no single function that computes a run's full path. Read `docs/orchestration.md` before touching this file.

**`Run.mode` gotcha**: `pinned` (the default) snapshots the graph into `runs.graphSnapshot` at creation and *never* re-reads it — a routing edit made afterward has zero effect on that run, by design. Only `mode: "live"` re-resolves against the current graph on every hop. Forgetting this produces a run that silently ignores reroutes with no error (bit the e2e suite once already).

**Edge kinds** (`explicit` | `auto` | `consensus`) are resolved by three different strategies in `resolve.ts` and `engine.ts::dispatchConsensus()`. A `consensus` source node fans out to every edge in its `consensusGroup.edgeIds` concurrently (inline within one BullMQ job, not as separate queued hops — a deliberate v1 simplification), joins via a `fanout_batches` row, then dispatches `aggregatorNodeId` with every branch's output. `consensusGroup` can only be set via `PATCH /graphs/:id/nodes/:nodeId` — never at node-creation time, since it references edge ids that don't exist until the node and its edges already exist.

### Every node row returned by the API must go through `nodeRowToAgentNode()`

Postgres stores position as flat `positionX`/`positionY` columns; `AgentNode` needs `position: {x, y}`. Returning a raw `.returning()` row directly (instead of mapping it) previously crashed the canvas with `t.position is undefined`. Same pattern applies to `AgentGraph` (`POST`/`PATCH /graphs` must return the fully-hydrated shape via `loadLiveGraph()`, not the raw update row, since `AgentGraph` requires `nodes`/`edges`/`warnings`). If you add a route that returns a node or graph, reuse the existing mapper — don't hand-roll another one.

### Providers, credentials, and tools

`packages/providers` wraps the Vercel AI SDK (`ai` v7 — note the `inputSchema`/`schema` naming, not v4's `parameters`) behind one interface per provider, each declaring capability flags (`streaming`/`toolCalling`/`vision`) rather than assuming uniform support. Credential resolution (`apps/api/src/orchestrator/credentials.ts`) checks, in order: a node-specific stored credential, then a graph-wide one, then an environment variable — stored credentials are AES-256-GCM encrypted (`apps/api/src/auth/crypto.ts`) and the plaintext never appears in any API response. `callAgent()` in `engine.ts` tries `node.fallbackChain` in order, but only falls through on a *classified* auth/model error (`providerErrors.ts`) — a generic bad-request never triggers fallback, since retrying identical bad input against a different provider won't help.

The tool registry (`packages/providers/src/tools.ts`) is intentionally a small built-in set (`calculator`, `current_time`), not dynamic npm-package loading — that would let anyone who can edit a graph run arbitrary code in the API process. The file-access tools (`read_file`, `list_directory`) are parameterized per-node by `AgentNode.fileAccessRoot` and enforce the path-traversal boundary via `path.relative()` — both the tool name *and* a configured root are required (defense in depth; neither alone grants access).

### Auth

Cookie-based sessions using an HMAC-signed opaque token (`apps/api/src/auth/session.ts` — no session table, verification is a local recompute) and scrypt password hashing (`password.ts`) — deliberately avoiding bcrypt/argon2 native modules after repeatedly hitting Docker build network flakiness fetching large native binaries in this environment. **Fastify plugin gotcha**: `authPlugin` must be wrapped with `fastify-plugin` (`fp()`) — without it, `register()` creates an isolated encapsulation context, and `decorateRequest`/`addHook` silently never reach sibling route registrations (`req.userId` would be `undefined` everywhere except inside the plugin itself). This exact bug shipped once already, and the same class of bug hit `app.setErrorHandler(...)` too — it must be registered in `apps/api/src/index.ts` **before** any `app.register(...)` calls for the route plugins, or the already-created child contexts never inherit it (invalid bodies silently 500'd instead of 400'ing until this was reordered). Cookie `secure` is controlled by `COOKIE_SECURE`, deliberately *not* tied to `NODE_ENV` — a self-hosted "production" deployment very often still serves plain HTTP, and tying it to `NODE_ENV` silently breaks every login. CORS (`WEB_ORIGIN` env var, `credentials: true`) is required since the web app (port 3000) and API (port 4000) are different origins.

**Any Next.js page that calls an auth-required endpoint must be a client component.** A server component's server-side `fetch()` never carries the browser's session cookie — it'll 401 with an opaque "Server Components render" crash the moment an endpoint gains `requireAuth`, even though it may have "worked" fine while that endpoint was public. Follow the `GraphPicker`/`Dashboard`/`runs/page.tsx` pattern: `"use client"`, `useAuth()`, fetch in `useEffect`. `useSearchParams()` in a client component additionally needs a `<Suspense>` boundary or the Next.js build fails.

### `fileAccessRoot` and the operator allowlist

`AgentNode.fileAccessRoot` alone is not the security boundary — `ALLOWED_FILE_ACCESS_ROOTS` (comma-separated env var, `apps/api/src/validation/fileAccessRoot.ts`) is an *operator*-level allowlist that any per-node `fileAccessRoot` must be a subdirectory of, checked via `zod.refine()` at both the manual node route and quick-add. Secure by default: an empty/unset allowlist means no agent, however configured, can be granted file access at all. Keep every legitimate use case in the *same* comma-separated value — overwriting it for a new purpose (e.g. adding real project directories) silently drops previously-allowed paths (e.g. the e2e test fixture root) and breaks unrelated tests.

### `pc_telemetry` and local read-only integrations

`packages/providers/src/tools.ts`'s `pc_telemetry` tool talks to a sibling project (linux-command-centre) over its plain WebSocket (`PC_TELEMETRY_WS_URL`, default `ws://127.0.0.1:52341`) using Node's built-in global `WebSocket` — no new dependency. It only ever sends `{subscribe: channel}` for `thermal`/`battery` and reads the response; there is no message it can send that mutates anything. This is a deliberate pattern for any future "monitor an external local system" tool: read-only wire protocol in, no control/write path, full stop — see PLAN.md's "PC Health Monitor — capability boundary" for why control automation there was explicitly rejected even though it's technically wirable via a Polkit-gated helper.

For local development, reaching a host-bound service like linux-command-centre from inside the `worker` container needs `docker-compose.override.yml` (gitignored, never committed — standard per-operator Compose customization) setting `network_mode: host` on `worker`, which in turn requires overriding `DATABASE_URL`/`REDIS_URL` to `localhost` since host networking bypasses the Compose bridge network's service-name DNS.

### Auto-routing needs to be told its own candidates

A router/supervisor node's `auto` edges are resolved by matching its output against target descriptions — but the model dispatching that node has zero built-in knowledge of what those targets even are. `engine.ts`'s `getAutoRoutingTargets(graph, nodeId)` + `appendAutoRoutingContext(systemPrompt, targets)` auto-injects a formatted `{name, description}` list into any node's system prompt whenever it has outgoing `auto` edges (wired into both `dispatchHop`'s and `dispatchConsensus`'s calls to `callAgent`). Don't rely on a hand-written system prompt to enumerate its own routing options — it's easy to get away with in a hardcoded demo prompt and then fail silently (`UNKNOWN`/misroute) the moment a prompt is generated more generically (e.g. via quick-add). This is engine-level and automatic; no per-node prompt authoring should need to duplicate it.

### Data model = one graph per session, not one global hierarchy

Each graph is a self-contained task/session with its own node hierarchy, routing, and run history — not a subtree of one universal org chart. This is deliberate: it scopes file-access grants, keeps conversation memory (see below) from bleeding across unrelated tasks, and templates (`agent_templates` — export a graph as a self-contained JSON snapshot, instantiate a deep copy with fresh node/edge ids) already solve "reuse this agent structure for a different task."

### Dashboard's chat memory has no backend component

`apps/web/app/dashboard/page.tsx` implements multi-turn conversation memory for single-node "bot" graphs entirely client-side: each new message's `run.input` is built by chaining the previous completed run's own `input` + `output` + the new message into one growing transcript string (see `buildNextInput`). The engine has no concept of conversation turns — it just sees a longer prompt each time. Display recovers "just this turn's message" by taking the text after the last `"User: "` marker in the transcript (`extractLatestUserMessage`) rather than storing turns separately.

### Docker build resilience

Both `apps/api/Dockerfile` and `apps/web/Dockerfile` use a BuildKit cache mount (`--mount=type=cache,target=/pnpm-store`) and filter the install to just that app's dependency tree (`pnpm install --filter "@openbots/api..."`) even though every workspace `package.json` must still be copied in for pnpm to reconcile the lockfile. This exists because this environment's Docker build network has repeatedly failed on large tarballs (`next`, `@next/swc-*`, `esbuild`) — if a build fails with `ERR_PNPM_TARBALL_FETCH_TARBALL`, it's almost always transient network flakiness, not a real dependency problem; retry before assuming something's broken.
