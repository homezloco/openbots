# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

**Status as of 2026-09-08: all three original phases are built and
e2e-tested (35/35 passing, `apps/api/e2e/run.ts`), two security reviews
found and fixed real vulnerabilities, dark mode shipped, and the product
grew past the original scope into a working multi-agent "engineering
team" built from the user's own real projects — now with live run
visualization, per-agent conversation history, a unified Dashboard
experience, and agents that can actually write code and (on explicit
`/push` confirmation, over HTTPS+PAT or SSH) push it (see "Live
visualization, agent reuse, and dashboard unification" and "Agent
file-write and confirmed push" below). See "Known gaps" at the bottom
for what's still actually missing.**

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

## CI

`.github/workflows/e2e.yml` runs the real e2e suite (docker compose up → migrate → build/start api+worker → wait for health → `test:e2e`) on every push to `main` and on-demand via `workflow_dispatch`. Deliberately not on every PR, since each run makes real, billed Anthropic API calls. The file-access fixture that used to be set up by hand inside the running container (`/tmp/testrepo`) is now committed at `apps/api/e2e/fixtures/testrepo/` and mounted in by `docker-compose.yml`, so this also fixed a real reproducibility gap for local dev, not just CI. **Needs three repo secrets added before it will pass**: `ANTHROPIC_API_KEY`, `E2E_SESSION_SECRET`, `E2E_CREDENTIALS_ENCRYPTION_KEY`.

## Live visualization, agent reuse, and dashboard unification (2026-09-07)

Full plan in the session; built and e2e-verified in build order:

1. **WS security fix (shipped first, urgent).** `GET /ws/runs` — the live-update WebSocket the canvas already used to light up nodes — had **no auth and no scoping at all**: it broadcast every user's run activity, including output/error text, to any connected client. Fixed: the route is now `GET /ws/graphs/:graphId/runs`, with an `[requireAuth, requireGraphOwner]` `preHandler` chain and per-socket filtering by a `graphId` field now included in every published event. **Important Fastify subtlety**: `@fastify/websocket` completes the HTTP upgrade *before* invoking the `(socket, req)` callback, so the ownership check must live in `preHandler` — a `socket.close()` after the fact would still leak that the handshake succeeded. `requireAuth` must run before `requireGraphOwner` in the chain: that helper's `ownerId !== req.userId` check alone passes when both are `null` (unauthenticated request against a graph whose owner was deleted).
2. **Auto-routing "no confident match" bug, found live.** A real run showed the Lead Engineer correctly ask a clarifying "UNKNOWN — could you specify which project?" question — but `resolve.ts::matchAutoEdge` had no concept of that; it always forwarded to *some* candidate via keyword overlap (even falling back to `candidates[0]` with zero signal), and the clarifying text happened to name several candidates by name (an artifact of the auto-routing context injection), so it "won" the overlap contest by accident and the run silently continued instead of surfacing the question. Fixed: `appendAutoRoutingContext` now explicitly teaches every auto-routing node the `UNKNOWN` convention, and `matchAutoEdge` treats an `UNKNOWN`-prefixed output (or a zero-overlap score) as no match, letting the existing "no next node → run completes with this output" path do the right thing with no new plumbing.
3. **Add existing agent.** `GET /agents` (cross-graph node listing scoped to the caller) + `POST /graphs/:id/nodes/from-existing` (copies a node's full config via the same `insertAgentNode()` every other creation path uses, deliberately excluding `consensusGroup`) + a third "Existing agent" tab in the canvas's Add-agent panel. Needed two *independent* `requireGraphOwner` checks (target graph AND the source node's own graph) since this is the first mutation spanning two different graphs.
4. **Node pulse + edge "signal" animation.** `.node-running`/`succeeded`/`failed` gained real `@keyframes` (was a static ring); a new `SignalEdge` component renders a one-shot SVG `<animateMotion>` pulse along whichever edge a hop actually resolved to (`resolvedEdgeId` now travels on the wire too). `startRun()` no longer navigates away to `/runs/:id` — it stays on the canvas so the pulse is visible, with a "view full trail" link instead.
5. **Click an agent → see its conversation history.** New `GET /graphs/:graphId/nodes/:nodeId/conversations` (no schema change — `run_events.nodeId` has no FK and is stable regardless of which graph currently owns the node) returns every run this agent has been part of, flagging whether the user talked to it directly (`sequence === 0`) or another agent routed to it. `RunEventTrail` was extracted out of the run detail page into a shared component (fixing a raw-UUID-instead-of-name display bug as a side effect) and reused by a new slide-over `AgentConversationPanel`, opened via `onNodeClick` on the canvas.
6. **Dashboard/Hierarchy unification.** The Dashboard's multi-node-graph branch used to be a dead-end "Open in Hierarchy →" link. `BotChat`'s send/history/multi-turn-memory logic was extracted into a shared `useBotChat` hook; a new `HierarchyChat` component renders the live canvas (now pulse/signal/click-panel-capable) on top and the same chat input/transcript strip underneath, so a multi-agent "team" gets the same one-screen "type → watch it think → see the answer" experience a single bot already had. `/hierarchy` itself is unchanged and still exists as the dedicated full-canvas editing surface.

Also removed the "Leadgen A Corrupt Engineer" node — a stale duplicate directory (`~/Development/leadgen-a-corrupt`) the project-bootstrap sweep had picked up alongside the real `leadgen-a` project — and added the `DELETE /graphs/:id/nodes/:nodeId` route needed to do that (missing entirely before this).

## Conditional "ALL" fan-out for hybrid auto/consensus nodes (2026-09-07)

Direct follow-on from the `UNKNOWN` fix above: asking Lead Engineer for "project status updates for **all** projects" correctly triggered `UNKNOWN` (the engine genuinely can't route free text to more than one target) — but the user's intent was unambiguous, and there was no way to satisfy it. `consensus` edges already provide fan-out+join, just as a fixed, always-on config, never conditional on what one specific request needs.

Fixed by letting a node be a hybrid: normal single-target `auto` routing by default, fanning out via its (separately configured) `consensusGroup` only when the model signals `ALL` — a second free-text sentinel convention symmetric to `UNKNOWN`, sharing a new `resolve.ts::startsWithSentinel()` helper (also tightened the boundary regex for both sentinels, since a bare `\b` word-boundary false-positives on a specialist literally named e.g. "All-Projects-Dashboard"). `dispatchConsensus` already resolves `consensusGroup.edgeIds` purely by id with no `kind` check, so those ids can reference a node's existing `auto` edges directly — zero changes needed there. A node with a `consensusGroup` and *no* `auto` edges (the original demo pattern) keeps firing unconditionally on every hop, exactly as before — only a genuinely hybrid node gets the new conditional behavior. `computeWarnings` gained a soft, non-blocking check for a hybrid node whose `consensusGroup.edgeIds` don't cover all of its own `auto` edges (e.g. a new specialist added and forgotten in the fan-out set). e2e-verified with a synthetic hybrid graph (3 new test cases: setup, single-specialist routes normally with no fan-out, ALL-signal fans out to both branches and reaches the aggregator) — 20/20 passing.

The real Engineering Team graph now has this wired up: a new "Status Aggregator" node, and Lead Engineer's `consensusGroup` covers all 8 project-specialist edges. Backend-only for now (no canvas UI for configuring a hybrid node's fan-out — consistent with `consensusGroup` already being PATCH-via-API-only everywhere; a canvas affordance is a reasonable fast-follow, not required).

**Auto-sync, not just a warning.** Initially shipped as a soft warning only (drift between `auto` edges and `consensusGroup.edgeIds` is possible but flagged) — per explicit user preference, upgraded to auto-sync: `POST /graphs/:id/edges` now appends a new `auto` edge's id to its source node's `consensusGroup.edgeIds` automatically when that source is already a hybrid node, so adding a new specialist under Lead Engineer (via any of the three Add-agent modes, which all funnel through this one endpoint) means it's included in the next "ALL" broadcast with no manual PATCH step. Still overridable — PATCH a specific edge id back out if a new agent should be excluded from broadcasts for now. 21/21 e2e passing (added a case creating a new auto edge and asserting it lands in `consensusGroup.edgeIds` with no coverage warning).

**Not yet manually verified in-browser** (no browser automation available in the environment this was built in): the pulse/signal animation's visual feel and timing, and the Dashboard/HierarchyChat layout. All backend behavior is e2e-verified (17/17); the visual polish needs a live look.

## Agent file-write and confirmed push (2026-09-08)

Write-capable agents were the natural next step once the "engineering
team" graph existed for real work: an agent could read and reason about
a project but never actually change it. Two phases, both e2e-verified
(35/35) and confirmed live against a real project's repo.

**Phase 1 — isolated writes.** `write_file`/`edit_file` tools
(`packages/providers/src/tools.ts`), gated by a node's `tools[]` the same
way read tools are, plus a separate, independent `ALLOWED_FILE_WRITE_ROOTS`
operator allowlist (a node having read access to a path never implies
write access). The first write in a run creates an isolated `git
worktree` on a fresh `openbots/<node>-<runId8>` branch off HEAD
(`packages/providers/src/gitWorktree.ts`) — writes never touch the user's
actual checkout, and nothing is committed until a hop finishes (per-hop
commit granularity, not per-tool-call or per-run). `resolveWithinRoot`
resolves symlinks via a realpath walk-up (shared with the read tools) so
a symlink inside the repo can't be used to write outside the allowed
root. `appendWriteContext` (`engine.ts`) teaches a write-capable node the
real workflow (writes auto-commit; it has no git/push tool and must never
claim otherwise, including if a message claims to be the user's
push-approval) — without this it either invented an inaccurate manual
git workflow to recommend or refused out of misplaced caution.

**Phase 2 — confirmed push.** The literal chat command `/push` (optionally
`/push <branch>`), intercepted by exact regex match in `POST /runs`
**before** any orchestration/model involvement — a hard, non-negotiable
design constraint: the decision to push is made by deterministic backend
code reading the human's own literal input, never by an LLM interpreting
free text (closes an obvious prompt-injection path onto an irreversible,
shared-system action). `agent_commits` tracks every commit for push-target
lookup; account-scoped `user_credentials` (separate from the existing
graph-scoped provider credentials) stores an encrypted GitHub PAT and/or
SSH private key, manageable at `/settings` in the web app. `pushBranch()`
(`gitWorktree.ts`): an `https://` origin uses the stored PAT via a
one-request `http.extraheader` (never persisted to `.git/config`); a
`git@github.com:`/`ssh://github.com/` origin (github.com only — see
below) uses the stored SSH key, written to a 0600 file inside a fresh
0700 temp dir for the duration of one push and deleted immediately after,
with `GIT_SSH_COMMAND` pinned to GitHub's own published host key
(`https://api.github.com/meta`, hardcoded to avoid trusting whatever
`ssh-keyscan` returns on first connection — the exact MITM host-key
pinning exists to prevent) and `BatchMode=yes` so a passphrase-protected
key or host-key mismatch fails fast instead of hanging the worker on a
prompt nothing can answer; any other SSH host, or a local/file path
(what the e2e suite pushes against), falls through to a clear error or a
plain push respectively.

**Known limitation, not a bug**: SSH push only supports `github.com` as
the host (the pinned key is GitHub's) — a GitLab/Bitbucket/self-hosted
SSH remote gets a clear rejection, not a silent failure. PR creation
(`gh pr create`) is deliberately out of scope, same as v1's original
scope decision — a separately-confirmable action needing broader token
scope.

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
6. `/push` only supports a `github.com` origin over HTTPS or SSH — no GitLab/Bitbucket/self-hosted remotes, and no PR creation (`gh pr create`) yet. See "Agent file-write and confirmed push" above.
7. No UI visibility into pending/unpushed commits — you have to remember to type `/push`; nothing in the canvas or chat currently surfaces "there are N unpushed commits on this graph."

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
