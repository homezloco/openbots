# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

**Status as of 2026-09-07: all three original phases are built and
e2e-tested (15/15 passing, `apps/api/e2e/run.ts`), a security review found
and fixed two real vulnerabilities, dark mode shipped, and the product
grew past the original scope into a working multi-agent "engineering
team" built from the user's own real projects. See "Known gaps" at the
bottom for what's still actually missing.**

## Phase 1 — MVP

- Graph data model + Postgres schema (`packages/graph-schema`, `apps/api/src/db`). ✅ Verified.
- Canvas UI: create/connect agent nodes, drag-and-drop rerouting, natural-language quick-add, "connects from" wiring, dark mode. ✅ Verified live in-browser.
- Orchestration engine: lazy per-hop routing resolution, `pinned`/`live` run modes, per-node timeout/isolation, status-aware retry. ✅ Verified across many runs.
- All 5 providers (Anthropic/OpenAI/xAI/OpenRouter/openai-compatible) via one adapter layer. ✅ Anthropic path verified live extensively.
- `explicit` / `auto` / `consensus` routing edges — all three ✅ verified end-to-end via the e2e suite and multiple real multi-agent graphs (see below).
- True mid-run rerouting (drag an edge while a run is actively generating, `mode: "live"`) — ✅ verified in the e2e suite.

## Phase 2 — Provider gateway + dashboard parity

- Full adapter layer, cross-provider fallback chains, encrypted per-node credential storage, usage/cost tracking. ✅ All verified in the e2e suite (fallback classification, stored-credential resolution, real token/cost figures).
- Dashboard evolved into a full **bot roster** (Grok Bot pattern) with natural-language bot creation and real multi-turn conversation memory (built client-side by chaining each run's transcript forward — no engine changes). ✅ Verified live.

## Phase 3 — Growth

- Tool/plugin system: built-in registry (`calculator`, `current_time`), a scoped read-only file-access tool (path-traversal protected, operator allowlist via `ALLOWED_FILE_ACCESS_ROOTS`), and `pc_telemetry` (reads a local linux-command-centre instance's read-only WebSocket telemetry — see "PC Health Monitor" below). ✅ All verified.
- Agent template marketplace (save/instantiate a graph as a reusable snapshot). ✅ Verified.
- Run replay/audit UI. ✅ Verified live (see "Runs pages" bug below for a regression that briefly broke this).
- Multi-user auth (signup/login, graph ownership). ✅ Verified — team/role-based sharing intentionally out of scope.
- `consensus` edge type (fan-out to N nodes, join, hand to an aggregator). ✅ Verified — `consensusGroup` can only be set via `PATCH /graphs/:id/nodes/:nodeId` (added specifically for this — it references edge ids that don't exist at node-creation time).

## Beyond the original plan

- **"Master agent" quick-add**: describe an agent in plain English, an LLM produces its config through the same API as manual creation. ✅ Verified repeatedly, including producing a genuinely well-scoped, safety-conscious system prompt for the PC Health Monitor without being explicitly told to add those constraints.
- **Real project bootstrap**: read every `Development/*/CLAUDE.md` on the operator's machine and quick-add one agent per project, each scoped to read-only file access on *only* its own project directory (`docker-compose.override.yml` mounts the host's projects dir into the worker; `ALLOWED_FILE_ACCESS_ROOTS` permits it at the operator level; each node's own `fileAccessRoot` narrows it further). Verified against 9 real projects, confirmed one can correctly read and reason about its actual project's files.
- **Multi-project "Engineering Team"**: the 9 project agents were consolidated into one graph under a "Lead Engineer" supervisor using `auto` edges — same delegation pattern as the Billing/Code/Research test. This surfaced a real engine gap (below) that's now fixed.
- **PC Health Monitor**: a read-only/advisory agent using `pc_telemetry` (thermal/battery) plus file access to the linux-command-centre repo's own docs. Deliberately does NOT wire up any control/write actions — see the risk writeup below.
- `GET /graphs` roster + `DELETE /graphs/:id` + `PATCH /graphs/:id/nodes/:nodeId` endpoints, graph pickers on Hierarchy/Runs.
- Reviewer/tier mismatch warning, supervisor (👑) / reviewer (🔎) canvas markers.

## Real bugs found and fixed this session

Beyond the two security findings (below), building real multi-agent graphs surfaced:

1. **Auto-routing had no candidate context.** A router/supervisor node's `auto` edges are resolved by matching its OUTPUT against target descriptions, but nothing ever told the model what those targets *were* — a hand-authored prompt that happened to list the category names (the original Billing/Code/Research test) worked by accident; a quick-add-generated Lead Engineer prompt that said "route based on the list of engineers available to you" had no such list and produced `UNKNOWN`/misrouted every time. Fixed at the engine level (`engine.ts::getAutoRoutingTargets`/`appendAutoRoutingContext`): any node with outgoing `auto` edges now automatically gets its candidates' names+descriptions appended to its system prompt. This is automatic for every future router, not something each prompt has to get right by hand.
2. **Two `/runs` pages crashed after the security fix.** `GET /graphs/:id/runs` and `GET /runs/:id` correctly gained `requireAuth` in the security review, but `apps/web/app/runs/page.tsx` and `apps/web/app/runs/[id]/page.tsx` were still **server components** — a server-rendered fetch never carries the browser's session cookie, so both now always got 401'd, crashing with an opaque "Server Components render" error. Converted both to client components (same fix as `GraphPicker`). **Pattern to watch**: any page component calling an auth-required endpoint must be a client component (or use `next/headers` to forward cookies explicitly) — a server component silently "works" against public endpoints and silently breaks the moment an endpoint is locked down later.
3. Fixed the same `ALLOWED_FILE_ACCESS_ROOTS` value being reused for two different purposes (real projects vs. the e2e test fixture) and clobbering each other — the env var is a comma-separated list for exactly this reason; both need to coexist.

## Security review (2026-09-07)

Full review + fixes documented in the session; two real, high-confidence findings:

1. **Arbitrary file read via unconstrained `fileAccessRoot`, HIGH.** Nothing previously stopped a `fileAccessRoot` from pointing anywhere on the filesystem, and self-signup was open — a free account could scope an agent to `/etc` or the app's own directory and exfiltrate secrets through a run's output. Fixed: `ALLOWED_FILE_ACCESS_ROOTS` operator allowlist (secure-by-default: empty = no agent can be granted file access at all), enforced in a shared zod schema (`apps/api/src/validation/fileAccessRoot.ts`) used by both the manual node route and quick-add. Also closed the compounding issue: `GET /runs/:id` and `GET /graphs/:id/runs` had **no auth check at all** — now both require ownership.
2. **IDOR/BOLA on node/edge/credential mutation routes, MEDIUM.** `PATCH /graphs/:id/nodes/:nodeId`, `PATCH`/`DELETE /graphs/:id/edges/:edgeId`, and `DELETE /graphs/:id/credentials/:credentialId` checked ownership of the URL's graph id but then looked up/mutated the sub-resource by its own id alone — an attacker's own graph id paired with a victim's node/edge/credential id would still pass. Fixed: every lookup/update/delete now scopes on `graphId` too.
3. Along the way, found and fixed a third bug of the same *class* as an earlier one: `app.setErrorHandler(...)` was registered after the route plugins, so — like the `authPlugin` encapsulation bug before it — the already-created child contexts never inherited it, and every invalid request body silently 500'd instead of 400'ing. Moved before route registration.

All three are covered by new e2e regression tests (`security: ...` cases in `apps/api/e2e/run.ts`).

## PC Health Monitor — capability boundary (deliberate)

linux-command-centre (a sibling project) has no REST API — only a
read-only WebSocket (`ws://127.0.0.1:52341`, thermal/battery) and a
separate privileged helper gated by an **interactive Polkit password
prompt** for every actual control action (service restarts, firewall
rules, user management, GRUB config, apt upgrades). `pc_telemetry` only
ever sends `{subscribe: channel}` to the read-only stream — there is no
message it can send that triggers a write. Deliberately **not** wired up:
passwordless/unattended access to the privileged helper, which would
grant an LLM-driven, potentially-scheduled agent standing root-equivalent
access with no human confirmation. If real control automation is wanted
later, scope it to a narrow, individually-reversible whitelist — never
the full privileged operation set.

**Not yet built**: an hourly/cron scheduling mechanism for runs — requested
alongside the PC bot, not yet implemented. BullMQ (already a dependency)
supports repeatable jobs natively and is the natural fit; needs a new
`scheduled_triggers` table + routes + worker wiring.

## Known gaps (honest list)

1. **No scheduling capability yet** (see above) — requested, not built.
2. **The containerized `web` Docker image has never successfully built** in this environment (persistent npm-registry network flakiness in this sandbox on large packages like `next`/`@next/swc-*` — the `api` image, which doesn't pull those, builds fine). The web app runs via local `pnpm start` against the dockerized API.
3. **Team/role-based sharing does not exist.** Auth is single-owner only, by design.
4. The tool registry is a small built-in set, not dynamic npm-package loading — deliberate (arbitrary plugin loading would let anyone who can edit a graph run arbitrary code in the API process).
5. Consensus fan-out runs branches inline within one BullMQ job (not as separately queued hops) and has no partial-failure tolerance — a v1 simplification, documented in `docs/orchestration.md`.

## Competitive notes (xAI Grok Bot / Grok Build, researched 2026-09)

- Grok Bot: conversational bot creation (name, color/shape, one-line job
  description), routing is **implicit and invisible** — delegation is
  inferred from description text matching, no graph/canvas UI exists.
- Grok Build Agent Dashboard: list-based session view, sorted by state
  (working/idle/blocked), subagents collapse under their parent — good
  triage pattern, still not a hierarchy visualization.
- Confirmed gaps OpenBots exploits: no visible/editable routing anywhere
  in the Grok lineup; single-vendor lock-in (no BYOK); shared-computer
  fragility (one stuck bot can take down a whole roster); paywalled
  behind a $300/mo bundle with reported compute ceilings.

## License

Apache-2.0 — explicit patent grant, standard for OSS infra/agent tooling.
