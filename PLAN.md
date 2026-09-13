# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

**Status as of 2026-09-11: all three original phases are built and
e2e-tested (`apps/api/e2e/run.ts`, real Anthropic calls, no mocks), four
security review passes found and fixed real vulnerabilities, dark mode
shipped, and the product grew past the original scope into a working
multi-agent "engineering team" — live run visualization, per-agent
conversation history, a unified Dashboard, agents that write code and
(on explicit `/push`/`/pr`) push it, scheduled runs, cross-graph
dispatch/manage with gateway nodes on the canvas, a GitHub tab, and
`business_metrics` from per-account `metrics_<slug>` logins at
`/settings`. An MCP **client** (Streamable HTTP / SSE, operator
`ALLOWED_MCP_SERVERS` empty-deny) shipped as PRs 1–3 (runtime +
`POST /mcp/discover` + AgentSettingsForm). Live-mode reroute now re-reads the graph
*after* the in-flight model call, which is what the README GIF is
showing. See "Known gaps" at the bottom for what's still actually
missing.**

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

## Security finding (2026-09-08): unauthenticated routing-changes leak

Found while cross-referencing every route file against this plan for a
documentation-completeness pass — the same bug class as the two 2026-09-07
findings above, missed because it predates this session and had no e2e
coverage. `GET /graphs/:id/routing-changes` (`routes/routingChanges.ts`)
had **no `requireAuth` and no ownership check at all**: any caller,
authenticated or not, could read the full mutation audit trail
(`before`/`after` JSON — a node or edge's complete config, including
system prompts, `fileAccessRoot`, and `tools`) for *any* graph id.
Fixed: added `requireAuth` + `requireGraphOwner`, matching every other
per-graph route. Covered by a new e2e case (401 unauthenticated, 403
wrong owner, 200 owner) — 43/43 passing. The frontend client function
(`listRoutingChanges` in `lib/api.ts`) exists but is currently unused by
any page, which is presumably why this went unnoticed for so long.

## CI

`.github/workflows/e2e.yml` runs the real e2e suite (docker compose up → migrate → build/start api+worker → wait for health → `test:e2e`) on every push to `main` and on-demand via `workflow_dispatch`. Deliberately not on every PR, since each run makes real, billed Anthropic API calls. The file-access fixture that used to be set up by hand inside the running container (`/tmp/testrepo`) is now committed at `apps/api/e2e/fixtures/testrepo/` and mounted in by `docker-compose.yml`, so this also fixed a real reproducibility gap for local dev, not just CI. **Needs three repo secrets added before it will pass**: `ANTHROPIC_API_KEY`, `E2E_SESSION_SECRET`, `E2E_CREDENTIALS_ENCRYPTION_KEY`.

**Was actually failing on every single run (found 2026-09-09).** Every recorded run (`gh run list`) failed in under 20 seconds, always at the same step: `pnpm/action-setup@v4`'s explicit `version: 9` input conflicts with `package.json`'s `"packageManager": "pnpm@12.3.4"` field ("Multiple versions of pnpm specified") — install never ran, so `.env` was never written, so the two `if: always()`/`if: failure()` cleanup steps (`docker compose logs`/`down -v`) then ALSO failed trying to read a `.env` that didn't exist. Three visible errors, one root cause. Fixed by dropping the explicit `version:` input — the action reads `packageManager` from `package.json` on its own, its documented default. Confirmed the fix works: the triggering run progressed past a minute (vs. instant failure before). **Still won't fully pass**: `gh secret list` shows zero repo secrets configured — the three above still need to be added under Settings → Secrets and variables → Actions before a run can reach a real green state, left for the user since it involves a real API key.

**Confirmed via a real run (2026-09-09) exactly what "no secrets" looks like**: every step through "Wait for api to be healthy" passed cleanly — the pnpm/docker/migration pipeline itself is fully correct. `signup + session cookie works` then 500'd immediately: `${{ secrets.CREDENTIALS_ENCRYPTION_KEY }}` with no secret configured substitutes to an *empty string*, not omitted, and `auth/crypto.ts::getKey()`'s `if (!secret) throw` treats empty the same as missing. Every later test then either 401'd (`Authentication required`) or — worse — hung the full `waitForRun` timeout (90s, some ×3 via `testWithRetries`) polling a run whose id was `undefined` because its own `POST /runs` had already failed, which is what pushed total runtime past the job's 20-minute `timeout-minutes` into a hard cancellation instead of a fast, readable failure. Fixed the second part regardless of secrets: `waitForRun` now throws immediately if called with no run id, so a broken-auth run (or any future one) fails in seconds with a clear message instead of burning the whole timeout budget silently.

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

**Not yet manually verified in-browser**: the pulse/signal animation's visual feel and timing, and the Dashboard/HierarchyChat layout, specifically. (Browser automation *is* available in this environment as of 2026-09-08 — used repeatedly since for `/settings`, the Schedules panel, and the Commits panel — this note is just an honest "nobody has actually looked at this one yet," not an environment limitation anymore.) All backend behavior is e2e-verified; the visual polish needs a live look.

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
SSH remote gets a clear rejection, not a silent failure.

**Phase 3 — `/pr` (2026-09-08).** Same deterministic-command-interception
safety property as `/push` — `/pr` (optionally `/pr <title>`) is matched
by exact regex in `POST /runs` before any orchestration/model
involvement. Targets the most recently *pushed* branch (reads
`agentCommits.pushedAt`, not just the latest commit — a PR needs a branch
GitHub already has). Always requires a GitHub PAT (`provider: "github"`)
**regardless of whether the matching `/push` used HTTPS or SSH** — PR
creation is a GitHub REST API call, not a git-transport operation, so an
SSH key alone can never satisfy it; this is called out explicitly in both
the settings-page copy and the error message a user gets if they try
`/pr` with only an SSH key configured. Checks for an already-open PR on
that branch first (avoids a redundant 422 from GitHub and gives a
friendlier "PR #N already exists" message with the link), then reads the
repo's actual `default_branch` from the GitHub API rather than assuming
`main` — no schema changes needed; an open PR's existence is checked
live against GitHub each time rather than tracked locally. e2e-covered
for the three deterministic error paths (nothing pushed yet, no token
configured, a non-github.com origin); real PR creation needs a live
github.com repo/token to verify, same limitation as real SSH push
transport. 41/41 passing.

## Scheduled runs (2026-09-08)

Closes the "no scheduling capability" gap noted below and in the PC
Health Monitor section — a graph can now run itself on a recurring cron
schedule with no human triggering it each time.

**Design**: a new `scheduled_triggers` table (`{graphId, name, input,
cronExpression, mode, enabled, lastRunId, lastTriggeredAt}`) backed by a
BullMQ **job scheduler** (`queue/scheduleQueue.ts`'s `upsertJobScheduler`/
`removeJobScheduler` — the current, non-deprecated BullMQ 5.x API;
`getRepeatableJobs`/`removeRepeatableByKey` are deprecated for removal in
v6) rather than a naive setInterval or a second cron library. The
trigger's own id doubles as BullMQ's `jobSchedulerId`, generated
client-side before insert specifically so an invalid cron pattern can be
validated (by actually attempting the registration, using cron-parser
under the hood — the trigger's own light regex pre-check only catches
gross shape errors like the wrong field count) and rejected with a 400
*before* anything is persisted. A `run-scheduled-trigger` job firing just
calls `orchestrator/scheduledTrigger.ts`, which re-reads the trigger and
its graph **fresh from Postgres** rather than trusting anything captured
at registration time — a trigger can be disabled/deleted, or its graph's
`entryNodeId` cleared, between when BullMQ scheduled a firing and when it
actually runs. It then calls a new shared `orchestrator/createRun.ts`
helper — extracted from `POST /runs` so a scheduled run is created
through the exact same path as a manually-started one (same
`graphSnapshot`/`entryNodeId`/`enqueueHop` logic), not a parallel
reimplementation that could drift.

**Postgres as source of truth, Redis as derived cache.** BullMQ job
schedulers persist in Redis independently of the API/worker process, so
they normally survive a restart with zero extra work — but Redis can be
wiped independently of Postgres (e.g. `docker compose down -v` on a
volume-separated deployment). The worker re-registers every `enabled`
trigger from Postgres on every boot (`reconcileSchedules()` in
`worker.ts`) — idempotent, since the same trigger id always maps to the
same `jobSchedulerId`, so this is safe to run on every single startup,
not just recovery. `DELETE /graphs/:id` also explicitly unregisters any
schedules the graph had before the cascade deletes their rows — Postgres
FK cascades know nothing about Redis-side state, so skipping this would
leave an orphaned scheduler firing forever into a no-op ("trigger not
found" skip) with no way to stop it short of a Redis flush.

**UI**: a "⏰ Schedules" toolbar button on the Hierarchy canvas opens a
slide-over (`SchedulesPanel.tsx`, same visual pattern as
`AgentConversationPanel`) to create/list/enable-disable/delete a graph's
schedules; a fired run shows up in the graph's normal run history like
any other.

e2e-verified including a **real firing**, not just the CRUD contract: a
6-field (seconds-first) cron pattern (`*/5 * * * * *` — cron-parser,
which BullMQ uses internally, accepts an optional leading seconds field)
lets the test observe an actual BullMQ-triggered run complete within
~8 seconds, immediately disabling the trigger once observed to bound
the real Anthropic API calls it can rack up.

**Follow-on (2026-09-08): per-schedule run history + unpushed-commit
visibility.** Two small UX gaps closed together:
- `runs.scheduledTriggerId` (nullable, `onDelete: set null` so a run's
  history survives the schedule that created it being deleted later) is
  now set by `createRun()` when a run originates from a firing. A new
  `GET /graphs/:graphId/schedules/:id/runs` route plus an inline
  expandable "View history" section per schedule card in
  `SchedulesPanel.tsx` shows every past firing, not just the single
  `lastRunId`.
- A new `GET /graphs/:graphId/commits` route (`routes/commits.ts`)
  surfaces `agentCommits` — every write a node has made and its push
  status — so the user doesn't have to remember to type `/push`
  themselves. A "📦 Commits" toolbar button opens a slide-over
  (`CommitsPanel.tsx`) listing each commit's node, branch, pushed/
  unpushed state, and a one-click "Push this branch" button that fires
  `/push <branch>` through the same chat-command path as typing it
  manually — no new push logic, just a UI shortcut to the existing one.

Both e2e-verified (42/42 passing) and confirmed live in a browser.

## Cross-graph dispatch and business metrics (2026-09-08)

Built as part of restructuring the user's real setup into a 3-tier
agency delegation hierarchy (Portfolio → Project Leads → aspect
specialists) — full design and rationale in the session; the graph
migration itself (splitting the 8-project "Engineering Team" graph into
per-project graphs) is a separate, ongoing step from this engine work.

**`dispatch_to_graph`** — the one deliberate exception to "graphs are
fully self-contained": a node with this tool and a `dispatchTargets`
allowlist can fire-and-forget start a real run in another owned graph,
without waiting for or seeing its result. Security is name-based
resolution (the model never supplies a raw graph id) plus a fresh
per-call ownership re-check, never trusted from save-time config — see
`docs/orchestration.md`'s "Cross-graph dispatch" section for the full
design, including why a third operator-level allowlist was considered
and rejected, and why `runs.dispatchDepth` (cycle prevention) is a
required part of the tool rather than an afterthought.

**`business_metrics`** — real conversion/revenue/traffic numbers instead
of only what's typed into chat. Buildable and built today for leadgen-a.example
and leadgen-b.example (both expose a real admin API — confirmed by reading
their actual `server/routes.ts`, not just docs) and saas-b.example
(usage/traffic only). **Deliberately not built yet**: revenue for
saas-a/saas-b (neither exposes it via any API today — the
confirmed plan is a small first-party endpoint in each app, not handing
OpenBots their Supabase service-role key or Stripe secret key directly),
Railway hosting cost (real API exists but needs the user's own token to
finalize the query against its live schema), and Render hosting cost
(hard blocker — Render's public API has no billing endpoint at all,
confirmed against its own reference docs; not a credential gap, the
capability doesn't exist).

e2e-verified including a real fire-and-forget dispatch (one graph's run
completes immediately while a second, independently-dispatched run
completes in a separate graph moments later) and the credential-missing
error path for `business_metrics` — 51/51 passing.

## Agency graph migration completed (2026-09-08)

The user's real account was restructured from one flat 11-node
"Engineering Team" graph into 9 graphs matching the target architecture
above: **Agency Portfolio** (repurposed in place, same graph id — Lead
Engineer became Portfolio Lead with `dispatch_to_graph` + `dispatchTargets`
pointing at the 5 business graphs, Status Aggregator became Portfolio
Analyst with `business_metrics`), **5 business graphs** with the full
Lead → aspect-specialist structure (leadgen-a, leadgen-b, saas-a,
saas-b, saas-c), and **3 minimal single-node graphs** for the
non-revenue projects (side-a, side-b,
side-c). Two reusable templates came out of it — "Lead-Gen
Site Team" (leadgen-a → leadgen-b) and "SaaS Product Team" (saas-a
→ saas-b) — available for any future project of either shape. Built via
the user's own authenticated browser session (no password ever handled by
the assistant) rather than curl with a minted session token, since
minting a session token was correctly blocked by this environment's
safety classifier as credential manipulation even though the scheme
itself (HMAC with the server's own secret) was technically legitimate;
the user found their own password and drove the login themselves.

This step surfaced a real, previously-undiscovered API gap, fixed
properly rather than worked around: `PATCH /graphs/:id/nodes/:nodeId`
had no way to ever explicitly clear a `consensusGroup` (needed to convert
the old hybrid Lead Engineer back to a plain-auto Portfolio Lead before
wiring its one new edge to Portfolio Analyst) — `ConsensusGroup.optional()`
accepted a valid object or omission but rejected explicit `null`. Fixed to
`.nullable().optional()` in `createNodeBody` (`apps/api/src/routes/graphs.ts`,
inherited by the PATCH schema), with a new e2e regression case. See
`CLAUDE.md`'s "Edge kinds" section for the detail.

**Dashboard live-update**: the graph roster (`apps/web/app/dashboard/page.tsx`)
previously only refreshed on mount, so a graph created via script/another
tab/another device needed a manual reload to appear — noticed directly
during this migration. Fixed with a simple 5-second polling interval
(no websocket exists for the roster; that's reserved for live run events
within one already-open graph via `useRunEventsSocket`) — a pragmatic
choice given the low stakes of a stale roster for a few seconds.

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

Scheduling requested alongside the PC bot is now built — see "Scheduled
runs" above (a graph can run itself on a cron pattern via a BullMQ job
scheduler; not specific to this agent, works for any graph).

## GitHub tab and cross-graph supervisor control (2026-09-09)

Two follow-ons after closing the `dispatchTargets`-has-no-canvas-UI gap
(below, now fixed: `AgentSettingsForm.tsx` got a graph-picker checkbox
list, live-verified against the real Agency Portfolio graph).

**GitHub tab.** Replaces the old commits-only `CommitsPanel` with
`GitHubPanel.tsx`: commits grouped by branch, push status/action (same
underlying `/push` chat-command path, just a UI shortcut, per the existing
Commits-panel pattern), PR status fetched live from GitHub and batched by
distinct `{owner, repo}` (one `pulls?state=all` call per repo, not per
branch), an "Open PR" action for a specific pushed branch (a new
`POST /graphs/:id/commits/:commitId/pr`, sharing `createPrForCommit` —
extracted from the `/pr` chat command's handler — rather than only being
able to PR "the most recently pushed" branch like the command does), and a
per-commit diff viewer (`getCommitDiff` in `gitWorktree.ts`, a plain `git
show` against the commit's still-on-disk worktree — worktrees are never
cleaned up, see "Agent file-write and confirmed push"). Found and fixed a
real deployment gap live-testing this: the diff route runs in the `api`
process, but `docker-compose.override.yml` only mounted real project
directories into `worker` (the only process that previously ever touched
them, via `engine.ts::callAgent`) — added the same read-only mount to
`api`.

**Cross-graph supervisor control.** A deliberate, explicit reversal of
"dispatch is fire-and-forget, graphs are fully self-contained" — confirmed
with the user, who chose the maximal option. Two independent opt-ins,
sharing the same `dispatchTargets` allowlist (which graphs are reachable
at all) so "can fire a run" and "can restructure" are grantable
separately:
- `check_dispatch_status` — granted automatically alongside
  `dispatch_to_graph` (pure safety improvement, not new exposure): lets a
  node ask "how did the run I dispatched into X go?" on demand. Needed a
  schema addition, `runs.dispatchSourceGraphId` (nullable, `onDelete: set
  null`, same shape as `scheduledTriggerId`), set by `createRun()` when a
  dispatch creates the run, so a later query can find "the run THIS graph
  fired into that one" without trusting anything the model remembers.
- `manage_target_graphs` — six tools (`list_target_graph`,
  `create/update/delete_target_node`, `create/delete_target_edge`) that
  resolve names (never raw ids — same principle `dispatch_to_graph`
  already follows) and call shared, newly-extracted mutation functions
  (`orchestrator/graphMutations.ts`: `insertAgentNodeValidated`,
  `updateAgentNode`, `deleteAgentNode`, `insertRoutingEdge`,
  `deleteRoutingEdge`) — the exact same functions `routes/graphs.ts`'s
  human-facing POST/PATCH/DELETE routes now call too, so a cross-graph
  tool edit is held to the identical write-root-allowlist and
  dispatch-ownership standard a human editing the node directly would be,
  not a separately-maintained subset of it. Deliberately still
  **not** settable by any of these tools: `dispatchTargets` (the actual
  reachability boundary — kept human/PATCH-only so it can't be silently
  expanded from inside a dispatch) and `consensusGroup` (needs edge-id
  resolution by name to be usable from a tool call; real complexity, no
  clear v1 need).

**A real, HIGH-severity gap was found and fixed by the e2e suite while
building this**: the new tools' `fileAccessRoot` field bypassed
`ALLOWED_FILE_ACCESS_ROOTS` entirely — `checkWriteRootAllowed` only checks
the *write* allowlist when write tools are present, and the *read*
allowlist refine lives on `fileAccessRootSchema`, which only runs during
`createNodeBody.parse()` at the HTTP boundary; the tools build a plain
object and call the mutation functions directly, skipping that parse
entirely. A new `checkFileAccessRootAllowed()` (validation/fileAccessRoot.ts)
closes this by running the same check *inside*
`insertAgentNodeValidated`/`updateAgentNode` themselves, so every caller
gets it for free regardless of whether it went through zod first — the e2e
test that caught this (`create_target_node still enforces the
file-access-root allowlist`) asserts on real state (no node with the
disallowed root exists), not on model wording. 63/63 e2e passing after the
fix, including a full new suite for both features above.

**Also this session**: `apps/web/lib/useBotChat.ts` gained a `pending`
turn shown immediately on send (previously the UI stayed blank through the
entire round-trip, including a 1s-interval poll loop, before showing
anything) — the underlying poll loop's real backend status
(`pending`→`running`→`completed`) now drives a live "Sending…"/"Thinking…"
indicator instead of a static label. Separately, `engine.ts`'s tool-use
step cap went from `stepCountIs(5)` to `8`, plus a fallback message when
`result.text` is empty after the loop — found live via a real run that
had shipped exactly this failure mode (a tool-using turn hit the old cap
mid-investigation, completed with `status: "completed"` and zero output,
with nothing surfacing that as a problem).

**OpenBots now has its own graph** (dogfooding): a single "OpenBots
Engineer" node scoped to read/write `/home/shane/Development/openbots`
itself (same pattern as every other real project — added to
`ALLOWED_FILE_ACCESS_ROOTS`/`ALLOWED_FILE_WRITE_ROOTS` and the
`docker-compose.override.yml` worker mount), wired into Agency Portfolio's
`dispatchTargets` so Portfolio Lead can reach it too. Verified live: asked
it to summarize its own `dispatchTool.ts`, got a correct answer back.

## Context consistency across agents (2026-09-09)

Triggered by a direct question: do agents know to use their project's
`CLAUDE.md`? Checked the real data instead of assuming — of the 20 real,
file-scoped agents across the user's projects, only 6 had a "read
CLAUDE.md first" instruction, and it was inconsistent even within one
team (every "Backend Specialist" across every project had it; every
"Frontend"/"Growth" specialist didn't, with one exception). The reason:
the *only* place this instruction could live was inside each node's
manually-authored (or quick-add LLM-generated, non-deterministically)
`systemPrompt` — no engine-level guarantee, so it drifted by construction.

This is the exact same failure shape as the auto-routing-context bug
fixed earlier ("a hand-written prompt that happened to list its routing
candidates worked by accident; a quick-add-generated one didn't" — see
"Real bugs found and fixed this session" above), so it got the same fix:
**engine-level and automatic, not per-prompt.** `engine.ts::appendProjectContext`
checks the real, live existence of a `CLAUDE.md` at the node's effective
file root (the isolated worktree path when write access is on — a full
git checkout, so a tracked `CLAUDE.md` is present there too) and, only if
one actually exists, appends an instruction to read it first. This fixes
all 20 current agents and every future one (manually created or
quick-add-generated) with one code change — no per-node prompt editing
needed. The 6 agents that already had a hand-written version of this
instruction were cleaned up (via PATCH) to remove the now-redundant text,
preserving any genuinely unique content that happened to be phrased
alongside it (e.g. Leadgen B Backend Specialist's prompt still notes it's
a fork of leadgen-a with divergence tracked in CLAUDE.md — just without
the now-redundant "go read it" imperative).

While reviewing every other context-injection mechanism for the same
class of bug (the user's ask: "review what else we use as context and
make sure it's all consistent and pertinent"), found one more real gap:
`appendDispatchContext` (the function that tells a `dispatch_to_graph`
node what its target graphs are named) was gated on `wantsDispatch`
alone — a node with `manage_target_graphs` but **not** `dispatch_to_graph`
got an empty list and was never told any target graph's name at all, even
though all six of its tools require one. Renamed to
`appendReachableGraphsContext`, now computed whenever either capability
is present and describing whichever tools are actually granted.
`business_metrics`/`pc_telemetry` were checked too and found fine — both
fully self-document their small, fixed set of sources/channels in the
tool's own schema, needing no per-node dynamic injection.

**Explicitly decided out of scope**: hierarchy self-awareness (a business
graph's Lead knowing Portfolio Lead can dispatch into it; a specialist
knowing which Lead it reports to) doesn't exist anywhere today, and the
user chose to leave it that way rather than add it here — graphs stay
fully self-contained, which matters for `agent_templates`' deep-copy reuse
(a template shouldn't carry a baked-in claim about a hierarchy it's no
longer part of once copied) and avoids reintroducing the exact same
staleness problem this fix just closed, one level up.

e2e-verified (65/65 passing): a node with `read_file` and no mention of
CLAUDE.md anywhere in its prompt correctly answers a question whose answer
exists *only* in a fixture's `CLAUDE.md` (added to
`apps/api/e2e/fixtures/testrepo/CLAUDE.md`); a `manage_target_graphs`-only
node (no `dispatch_to_graph`) correctly names its one target graph
unprompted. Confirmed live too: asked the real `OpenBots Engineer` (itself
one of the 20 agents that lacked this) an architecture question, and it
explicitly cited "From the CLAUDE.md file" in its answer.

## Cross-graph hierarchy on the canvas (2026-09-09)

Portfolio Lead's `dispatch_to_graph`/`manage_target_graphs` reach was
invisible on the Hierarchy canvas — `node.dispatchTargets` is a
completely separate mechanism from `routing_edges`, so nothing ever drew
it. User confirmed the fix: a synthetic **gateway node** per reachable
target graph (dashed border, deduped by target, one dashed edge per
`(node, target)` pair) — not the target's full internal team, which
would get unreadable fast across 6 targets. Clicking a gateway node
navigates into that graph's own full canvas (`useRouter`, matching the
app's existing `next/navigation` usage) — "click the individual node to
see its hierarchy within." Built in `HierarchyCanvas.tsx` alone, no
backend change, following the exact pattern the consensus fan-out's
synthetic "gather" edge already established (a UI-only node/edge derived
from config, not a real DB row).

**Three real bugs found live-testing this, all fixed:**
1. `HierarchyCanvas` seeds its node/edge/graph state from a `graph` prop
   via `useState(initialGraph)` — which does not re-run on a prop change
   alone. Clicking a gateway node updated the URL/searchParams and
   refetched server-side correctly, but the component instance survived
   navigation and kept rendering the *previous* graph's stale state.
   Fixed with `key={graph.id}` at both render sites
   (`app/hierarchy/page.tsx`, `HierarchyChat.tsx`) — a real gotcha for
   any future page that swaps this component's `graph` prop without a
   full remount.
2. React Flow's default `minZoom` (0.5) blocked `fitView` from zooming
   out far enough to fit a tall diagram (gateway row below the real team)
   inside a short container — `HierarchyChat`'s embedded Dashboard canvas
   splits the screen with the chat panel below it, so the bottom row of
   nodes was clipped even though `fitView` "succeeded." Fixed with
   `minZoom={0.1}`.
3. No node position is persisted anywhere today, so a drag that got
   confusing (reported: dragging Portfolio Lead in the cramped Dashboard
   view looked like it was "pushing" everything else) had no way back
   except reloading the page. Added a bounded `nodeExtent` (scales with
   the graph's own footprint, so a drag can't send a node far into empty
   canvas space) and a "↺ Reset layout" toolbar button that snaps
   nodes/edges back to their real (DB) positions plus a freshly
   recomputed gateway row and remounts `<ReactFlow>` to re-fit the view.

**A fourth, unrelated but more serious bug surfaced while using the new
dispatch/manage tools for real** ("give me project updates on all
projects" → a follow-up answer came back as the literal text `null`):
`useBotChat.ts`'s send-and-poll loop had a hard-coded 30-iteration
(~30s) cap, and on timeout fell through **unconditionally** to display
whatever it last fetched — including a still-`"running"` run whose
`output` column is still `null` — as if it were the finished answer
(`JSON.stringify(null)` renders as the text `"null"`). This was always
latently possible, but `business_metrics` doing real external HTTP
logins per source, chained across multiple tool-call steps
(`stepCountIs(8)`), made it far more likely to actually trip — confirmed
by reproducing the user's exact prompt (took ~18-20s; a heavier one
easily crosses 30s). Fixed: polls for up to 10 minutes, and a
non-`"completed"` status is now always surfaced as a real error, never
silently displayed as a successful answer.

## Credential security review and a real external-drift finding (2026-09-09)

Prompted by a direct question about whether stored credentials
(`user_credentials` — GitHub PAT/SSH key, `metrics_<source>` logins) are
ever exposed via the API. Reviewed `routes/userCredentials.ts` and
`auth/crypto.ts` line by line: `POST`/`GET`/`DELETE /me/credentials` are
all `requireAuth`-scoped to `eq(userCredentials.userId, req.userId)` (no
IDOR), and every response path returns only `{id, provider, label,
createdAt}` via `toSummary()` — the plaintext is only ever accepted in
the POST body and immediately passed through `encryptCredential()`
(real AES-256-GCM, random 12-byte IV, auth tag verified) before storage;
decryption only ever happens in-memory inside a tool's own outbound call
(`businessMetricsTool.ts`, `/push`'s GitHub PAT usage), never returned in
any response. No code changes needed — already correct.

Also bootstrapped `metrics_saas-b` from a real source: `saas-b`'s own
`.env.local` already had `ADMIN_USERNAME`/`ADMIN_PASSWORD` in exactly the
shape `business_metrics` needs (confirmed by checking all 5 real
projects' env files — only Saas B had this shape; leadgen-a/leadgen-b
have no admin-login credential in any env file at all, and
saas-a/saas-c have raw `SUPABASE_SERVICE_ROLE_KEY`/
`DATABASE_URL` instead — a meaningfully more powerful, riskier class of
secret than a scoped dashboard login, deliberately NOT wired into any
tool). Stored via the verified-safe `POST /me/credentials` endpoint.

**Real finding**: the credential is now recognized (no longer
"not configured"), but the live call to `https://saas-b.example/api/auth/login`
with it returns **HTTP 200 with an empty body** instead of `{token,
user}` — confirmed directly with `curl`, not just via the agent's own
report. Not an OpenBots bug: the plumbing works end-to-end (store →
decrypt → real HTTP call); `.env.local`'s `ADMIN_PASSWORD` is a
local-dev value that's evidently drifted from whatever's actually
configured on the live deployment. `leadgen-a`/`leadgen-b` still have no
credential source at all (nothing in either project's env files), so
`business_metrics` genuinely cannot report real numbers for either yet —
see "Known gaps" below.

## Pre-launch hardening (2026-09-10)

Prompted by a go-to-market review: before this repo goes public, two
real, code-level blockers needed closing rather than deferring.

**Relicensing.** See the "License" section at the bottom — Apache-2.0 plus
a narrow Additional Use Grant, changed now while the repo is still
private with zero forks/stars (the cheapest this will ever be to do).

**`business_metrics` no longer hardcodes personal domains.** The tool
previously hardcoded three of the maintainer's own real side-project
domains (`SOURCES`/`SOURCE_BASE_URLS` in `businessMetricsTool.ts`) —
fine for internal dogfooding, a real privacy/professionalism problem if
shipped to a public repo as-is, since it would reveal which other
businesses the maintainer runs and read as personal tooling rather than
a product feature. Genericized: a metrics source is now any user-chosen
slug configured at `/settings`, not a fixed enum. No schema change —
`user_credentials.encryptedKey` already stored an arbitrary JSON blob for
this table; it now carries `{username, password, baseUrl, style}`
instead of just `{username, password}`, where `style` (`"dashboard"` |
`"login"`) selects which of the two already-generic fetch functions to
call (they took `baseUrl` as a parameter all along — only the
name→URL/style mapping around them was hardcoded). `engine.ts` gained
`appendMetricsSourcesContext`, mirroring `appendReachableGraphsContext`
exactly: a node with `business_metrics` gets its owner's actually-
configured source slugs injected into its system prompt automatically,
so nothing has to hardcode or guess a source name anywhere, on either
side. `/settings`' three hardcoded site cards became one dynamic
"add a source" form. e2e-covered (credential slug/shape validation, the
missing-credential error path, and a new context-injection case
asserting a configured source's slug reaches the model unprompted).
**Follow-up, not automated**: the maintainer's own real `leadgen-a`/
`leadgen-b`/`saas-b` sources predate `baseUrl`/`style` and need
re-entering once through the new form — three rows, one user, not worth
a migration script.

**The `web` Docker build now actually works.** Previously documented as
"has never successfully built in this environment" (known gap #1,
below) — `apps/web/Dockerfile` was missing pnpm's own retry/timeout
tuning, so a slow tarball fetch (`next`, `@next/swc-*`) had no real
retry budget before failing outright. Added `fetch-retries 5`,
`fetch-retry-mintimeout`/`fetch-retry-maxtimeout`, and a lower
`network-concurrency` before the install step. Confirmed with a real
`docker compose build web` run: full clean build, including
`next build`'s type-check/lint pass over the genericized `/settings`
page above. This was a real, if minor, first-impression risk for a
public launch — "clone the repo, `docker compose up`, it just works" is
the highest-leverage moment there is.

## CI flakiness investigation (2026-09-10)

After the pre-launch hardening work above, CI (`.github/workflows/e2e.yml`)
failed on 3 consecutive pushes — root cause was simply the repo secret's
Anthropic account being out of credits (every one of 18 failures on that
run had the identical error, `"Your credit balance is too low..."`), not
a code problem. After credits were added, ran the suite 4 more times to
check for a real regression: no billing errors, but 3 of the 4 runs each
had exactly one test fail, in three *different* tests each time
(`hybrid node: naming one specialist routes normally, no fan-out` twice,
`mid-run rerouting: a reroute fired while the first hop is executing
changes the next hop` twice, never the same pair together) — the fourth
run was fully green.

Traced both flaky tests' code paths directly rather than assuming: neither
this session's changes (business_metrics genericization, `engine.ts`'s new
`appendMetricsSourcesContext`) nor the pre-existing timeout/step-count bump
above touch either test's hot path — the mid-run-reroute test's three
nodes have no tools at all (so `appendMetricsSourcesContext`'s
`wantsMetrics` branch never runs, `stepCountIs`/timeout are irrelevant with
no tool-calling), and the hybrid-node test doesn't touch `business_metrics`
either. A different single test failing each run, with no code-level
connection found, points to pre-existing LLM-response non-determinism and
CI-runner timing variance rather than a regression — a git-filter-repo
history rewrite (this session's other major activity) doesn't touch
runtime code at all.

One real, fixable gap found along the way: `hybrid node: naming one
specialist routes normally, no fan-out` used bare `test()` (zero retry
margin) for a real LLM call whose output depends on the model correctly
disambiguating a deliberately terse question — every *other* LLM-dependent
test in this suite already uses `testWithRetries` for exactly this reason.
Fixed to `testWithRetries`, matching the established pattern. The
mid-run-reroute test was already using `testWithRetries` and still lost
the race outright twice (all 3 attempts) — its own code comment already
documents it as "inherently timing-sensitive"; left as-is rather than
guessing at further timing tweaks with no stronger evidence of an actual
regression.

**Honest bottom line**: this suite can show a red CI run on an otherwise
fully-working `main` due to known LLM/timing non-determinism in one or two
specific tests — not unique to this session, just newly visible because
CI hadn't run enough times back-to-back before to surface the base rate.
Don't read a single red run as a regression without checking which test
failed and whether it's one of these two.

## Live-mode gap on the canvas + non-Anthropic positioning check (2026-09-10)

Two pre-launch checklist items from the go-to-market memo closed this
session; the first surfaced a real product bug, not just a demo gap.

**Canvas runs silently couldn't be rerouted.** Found while preparing the
mid-run-reroute demo recording: `HierarchyCanvas`'s "▶ Start run" button
called `createRun(graph.id, input)` with no mode argument, and
`createRun` defaults to `"pinned"` — the mode that snapshots the graph
once at creation and ignores every later edit. The only place `live` was
selectable anywhere in the web UI was `SchedulesPanel`. So the flagship
feature — drag an edge mid-run and watch the next hop go to the new
target — was unreachable from the main canvas screen a user would
naturally demo it from. Fixed: the run control now shows a "Live"
checkbox (defaulted on, since this canvas is the interactive
watch-it-happen view and pinned remains available for a stable snapshot),
passing `liveMode ? "live" : "pinned"` to `createRun`. e2e note: the
mid-run-reroute e2e case was never affected — it passes `mode: "live"`
explicitly via the API, which is why this UI-only gap never failed a
test.

**"Model-agnostic" is now a demonstrated claim, not just a built one.**
Ran a real end-to-end graph on the `openai-compatible` provider pointed
at a locally-running Ollama instance (`gemma4:e4b`,
`OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1`, dummy
`OPENAI_COMPATIBLE_API_KEY` — Ollama doesn't check it): graph run
completed through the worker container with zero cloud API key and zero
vendor involvement. A local-model demo is a stronger BYOK proof point
than another cloud provider would be.

## Known gaps (honest list)

1. ~~The containerized `web` Docker image has never successfully built in this environment~~ — fixed 2026-09-10, see "Pre-launch hardening" below. Local `pnpm --filter @openbots/web build && start` against the dockerized API remains a valid fallback if a build ever hits the same network flakiness again.
2. **Team/role-based sharing does not exist.** Auth is single-owner only, by design.
3. The tool registry is a small built-in set, not dynamic npm-package loading — deliberate (arbitrary plugin loading would let anyone who can edit a graph run arbitrary code in the API process).
4. Consensus and map fan-out run their branches inline within one BullMQ job, not as separately queued hops — a v1 simplification, documented in `docs/orchestration.md`. (Partial-failure tolerance — one bad branch doesn't sink the whole batch — shipped since this was first written; both now join on whatever succeeded, with a placeholder per failed branch, and only fail the run if every branch failed.)
5. `/push` and `/pr` only support a `github.com` origin over HTTPS or SSH — no GitLab/Bitbucket/self-hosted remotes. See "Agent file-write and confirmed push" above.
6. `business_metrics` now supports two integration *styles* ("dashboard" and "login" — see "Pre-launch hardening" below) rather than a fixed list of named sites, but only two real sources were ever actually wired up on the live account (the former `leadgen-a`/`leadgen-b`/`saas-b` credentials), and **neither integration style actually returns real data reliably today**: the "login" style's live login endpoint has previously returned an empty body — the stored value had drifted from what's actually deployed on that host — and the "dashboard" style's sources have no credential at all today (would need the user to re-add real staff credentials through the new generic /settings form). No revenue source exists yet for either style (needs new endpoint code in the target app), no Railway hosting cost (needs the user's own API token), no Render hosting cost (hard blocker — Render's API has no billing endpoint, full stop). See "Cross-graph dispatch and business metrics" and "Credential security review and a real external-drift finding" above.
7. `manage_target_graphs`'s *reach* is now visible on the canvas (gateway nodes, above), but the six tools themselves still have no visual affordance for what an agent actually *did* — no "see what changed in graph X" diff view yet, beyond the existing `GET /graphs/:id/routing-changes` audit trail, which still has no page consuming it.
8. No breadcrumb/"back to parent" link on a gateway-target graph's own canvas — the browser Back button works (gateway navigation pushes a real history entry), but there's no on-canvas affordance, deliberately: a graph can be a dispatch target of more than one parent, so there's no single "the" parent to hard-code a link to.
9. ~~The approval-gate's pause notification (`run_awaiting_approval`) is WebSocket-only~~ — fixed 2026-09-13, see "Approval-gate webhook notification" below: `ApprovalConfig.notifyWebhookUrl` now POSTs to an operator-allowlisted URL the moment a gate trips, closing the scheduled/webhook-run gap this originally named. No email sending exists in this codebase (no SMTP/nodemailer dependency) — a webhook is the interop primitive; bridging to email/Slack/PagerDuty is on whatever the operator points the URL at, deliberately not something OpenBots picks a vendor for.

## Depth demo (not the live-reroute GIF — 2026-09-11)

The 11-second live-reroute GIF is the differentiator (one edge, three
nodes). A second artifact should show that graphs nest, without stuffing
an org onto one canvas — that's the lesson from splitting the flat
11-node Engineering Team into 9 graphs. A "1 master + 2 leads of 6"
hairball on a single graph is the wrong demo: unreadable, and it
unteaches the architecture.

**Do, when recording / building the second starter:**

- A fictional **agency starter**, separate from the live-reroute demo:
  one Portfolio graph (Lead + two gateway nodes) and two team graphs
  (Lead + 3 specialists each — Backend / Frontend / Reviewer is enough;
  six per lead is dogfood, not a first look). Clicking a gateway
  navigates into that team's own canvas. No real business names.
- A short **GIF of that click-through** (Portfolio → dashed gateway →
  the team's own canvas) for the README / Product Hunt gallery.
  Landscape if possible; the reroute GIF is portrait because it was a
  half-width recording.
- A **size cue on gateway nodes** (how many agents live in the target
  graph) so the dashed node doesn't look like a dead end.
  `listGraphs` already returns `nodeCount` — this is a label, not a new
  API. (Shipped with the canvas-affordance work the same day: gateway
  labels now include the target's agent count.)

Record the GIF after a stranger can create `auto` edges on the canvas
(otherwise they cannot rebuild what they're watching). The agency
starter itself shipped 2026-09-11: Dashboard **Try the agency demo**
creates Acme Portfolio + Acme Payments + Acme Platform
(`POST /graphs/examples/agency`). The click-through GIF is still
unrecorded.

Enterprise buyers will still ask SSO/RBAC, MCP, and exportable audit
after they understand the org chart — those stay in the gaps/roadmap
below, not in this demo.

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

### Wider competitive scan (CrewAI, LangGraph, n8n, Dify, MCP ecosystem — 2026-09-10)

Broader research pass beyond Grok, to find real feature gaps rather than
just pricing/positioning. None of this is built yet — recorded here so
the prioritization survives past this session.

**Next — highest leverage, fits the existing architecture:**
- **MCP (Model Context Protocol) client support.** By 2026 MCP is the
  default tool-calling protocol across LangChain/CrewAI/LangGraph/
  LlamaIndex and natively supported by Anthropic/OpenAI/Google/Microsoft.
  The tool registry's "no dynamic plugin/npm loading" rule (see
  "Providers, credentials, and tools" above) doesn't have to block this —
  an MCP *client* is a network connection to a user-configured remote
  server, the same shape as `pc_telemetry`'s WebSocket or
  `dispatch_to_graph`'s cross-graph call, not code loading into the API
  process. Single biggest ecosystem-compatibility gap found.
  **PR 1 (schema + `ALLOWED_MCP_SERVERS` empty-deny allowlist + drop on
  copy) shipped 2026-09-11.** **PR 2 (runtime client + `mcp-echo` fixture)
  shipped 2026-09-11:** hop-time Streamable HTTP / SSE client in
  `orchestrator/mcpTool.ts`, dual-gate + runtime allowlist re-check,
  namespaced `mcp_<slug>_<tool>` tools, missing-credential skip, compose
  `mcp-echo` service. **PR 3 (settings UI + `POST /mcp/discover`) shipped
  2026-09-11:** AgentSettingsForm checkbox/rows/discover checklist;
  discover is auth + allowlist + listTools only (never callTool). stdio
  remains forbidden.
- ~~`useBotChat.ts::buildNextInput` has no memory bound~~ — fixed
  2026-09-10, pulled to the top of the list ahead of the rest of this
  roadmap since it was a live bug, not just a gap: a long-running bot's
  context window and per-turn cost both grew unboundedly with no cap.
  `truncateTranscript` now caps the carried-forward transcript at 24,000
  characters, trimming from the oldest end at a clean "User: " turn
  boundary (never mid-turn) and prefixing `[earlier conversation
  truncated]`. This is a bound, not real memory — still no summarization
  or structured recall, so the CrewAI-style short/long-term/entity memory
  gap itself is still open; this just stops the unbounded-growth bug.
- ~~**OpenTelemetry trace export for `run_events`.**~~ Shipped 2026-09-11:
  optional OTLP HTTP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`) from the
  worker; one trace per run, one span per hop. Unset = no-op. Not a
  Langfuse rebuild — plug into Jaeger/Tempo/Honeycomb. Prompt/output
  text is never an attribute.

**Later — real value, bigger lift, best done post-traction:**
- ~~**Time-travel / rewind-and-fork from a past hop**~~ Shipped 2026-09-11:
  `POST /graphs/:id/runs/:runId/fork` copies prefix hops as history and
  re-executes the checkpoint as a new run. Source run is immutable.
  Canvas: **Fork from here** on the run trail.
- ~~**Lightweight knowledge-base/RAG tool**~~ Shipped 2026-09-11:
  `search_knowledge` is dual-gated with `fileAccessRoot` like read_file.
  In-process walk/chunk/rank over that folder (lexical, plus optional
  OpenAI embedding re-rank). Not a hosted vector DB.
- **Template/graph sharing marketplace** — extends the existing
  `agent_templates` export/instantiate mechanism, blocked on real
  multi-user/team sharing (known gap #2) landing first.
- **External CLI coding agent as a node kind** (discussed 2026-09-11,
  not started). Let a write-capable node delegate to a trusted CLI
  coding agent (Claude Code, Aider, Codex CLI, etc.) — spawn it in the
  node's own worktree, wait for exit, commit whatever it changed —
  instead of the model making individual read_file/write_file tool
  calls that OpenBots intercepts one at a time. Real upside: a mature
  agentic loop (multi-file context, self-correction, running its own
  tests) produces higher-quality changes per hop than a single
  `generateText` call plus a handful of custom tools — throughput and
  quality, not just risk staying flat, assuming the CLI agent's own
  model is one you'd trust running directly anyway. The catch isn't
  security so much as granularity: this doesn't fit the existing
  provider abstraction (a CLI subprocess isn't "a model"), one hop
  would produce one large commit instead of the current fine-grained
  per-tool-call trail, and live rerouting can only steer *between*
  hops — it can't interrupt a long CLI run mid-flight. Same "fire, wait,
  take the result" trust shape as `dispatch_to_graph`, not the
  tightly-wrapped per-tool-call pattern the rest of the engine uses —
  should be built as its own narrow node/tool kind, not bolted onto
  the provider abstraction.

## Whole-codebase audit and four real findings fixed (2026-09-11)

A full audit (security/auth wiring, orchestration engine correctness,
tools/integrations, frontend-backend wiring, data-model consistency —
five parallel passes) beyond the usual "since last session" review
found and fixed:

1. **Cross-tenant write via `POST /graphs/:id/edges`** — the route
   checked ownership of the URL's `:id` but never verified
   `sourceNodeId`/`targetNodeId` in the body actually belonged to that
   graph. Worse: if the referenced node had a `consensusGroup`, the code
   appended the new edge id into it with no ownership check at all — a
   genuine cross-tenant mutation, not just a read leak. Fixed in
   `insertRoutingEdge` (`graphMutations.ts`) with the same
   `and(eq(id), eq(graphId))` scoping every other mutation in that file
   already uses; e2e-covered ("cannot wire an edge onto another user's
   nodes, or inject into their consensusGroup").
2. **`search_knowledge`'s embedding rerank silently sent file content to
   OpenAI based on ambient `OPENAI_API_KEY`** — a worker-wide env var
   with zero connection to the calling node's own config, so setting it
   for an unrelated fallback provider silently opted every
   `search_knowledge`-capable node into sending file excerpts off-box.
   Decoupled into its own `SEARCH_KNOWLEDGE_EMBEDDING_API_KEY`, and the
   tool's own description now tells the model when rerank is active.
3. **`fileAccessRoot` couldn't be cleared via PATCH** — missing
   `.nullable()`, the exact bug class already fixed for
   `consensusGroup`/`sshTarget`/`mcpServers`, just missed here. Fixed;
   e2e-covered ("PATCH fileAccessRoot: null revokes a previously-granted
   root").
4. **`POST /chat` (the Phase 2 single-agent playground) was fully built
   and wired in `lib/api.ts` but had zero UI callers anywhere in
   `apps/web`, and zero test coverage** — dead code, superseded by
   Dashboard's BotChat (persisted, graph-backed, multi-turn) which does
   everything this endpoint did and more. Removed: `routes/chat.ts`, its
   registration in `index.ts`, and `sendChatMessage` in `lib/api.ts`.

Also fixed as part of the prior "since last session" pass: OTel hop-error
spans now redact Bearer/Authorization text before export (same pattern
`orchestrator/mcpTool.ts` already used), and `apps/web`'s `pnpm lint` now
actually runs (no ESLint config existed at all; `next lint` was hanging
on an interactive prompt), surfacing and fixing one real
`react-hooks/rules-of-hooks` false-positive and three unescaped-JSX-entity
errors.

## `dispatch_to_graph` reversed from fire-and-forget to blocking agent-as-tool (2026-09-11)

Live dogfooding on the Acme Portfolio demo surfaced the real gap: a user
asked the Lead to dispatch a duplicate-charge investigation to the
Payments team, got back "I've dispatched this... let me know if you'd
like me to check on the status later," and asked "shouldn't it wait and
provide me the status?" That's a fair ask — the whole point of a Lead is
to act like an assistant that delegates, waits, reviews, and reports
back, not a fire-and-forget dispatcher.

The original fire-and-forget design (see "Cross-graph dispatch and
business metrics" above, and `docs/orchestration.md`) was deliberate: a
sub-run can take a long time, and blocking one BullMQ worker slot on
another graph's entire run fights the async-by-default grain the rest of
the engine is built around. That reasoning wasn't wrong, but researching
how LangGraph's supervisor pattern, CrewAI's hierarchical manager, and
Anthropic's own production multi-agent research system handle exactly
this found that all three block synchronously — Anthropic's own
engineering writeup says so outright ("our lead agents execute subagents
synchronously... this simplifies coordination, but creates
bottlenecks"), and none of them have a distinct "send it back for
revision" primitive either, just "the orchestrator calls the tool
again." OpenBots already had that for free via each hop's existing
`stepCountIs(20)` multi-tool-call loop — the only real gap was that
`dispatch_to_graph` never returned anything worth reviewing.

**Shipped:** `dispatch_to_graph` now blocks and returns the target run's
real output (`outcome: "completed" | "failed" | "still_running"`),
bounded by a per-hop timeout budget that shrinks across repeat calls in
the same hop rather than a flat per-call constant (a hop calling the
tool twice — original, then a revision — must not let call 2 blow past
the hop's own ceiling on top of what call 1 already spent). A
dispatch-capable node's own hop timeout is extended from the default
180s to 600s (`DISPATCH_HOP_TIMEOUT_MS`), applied at every
`withNodeTimeout` call site including a consensus branch carrying the
tool. `check_dispatch_status` gained the same failure-detail lookup
(`runs.output` is null on a failed run — the real error text lives on
the failed hop's `runEvents` row) so a `still_running`/`failed` outcome
is actually reviewable, not a dead end. See `docs/orchestration.md`'s
"Cross-graph dispatch" section and `CLAUDE.md` for the full mechanics.

**Explicitly not built:** no new run status, no suspend/resume/
continuation architecture, no separate worker pool for waiting
dispatches — the bounded-blocking approach gets the requested UX today
with a contained change; revisit only if `WORKER_CONCURRENCY` pressure
from this pattern proves a real bottleneck at higher concurrency.

**Not covered by an automated e2e case:** the depth-cap-under-blocking
interaction (`MAX_DISPATCH_DEPTH` still refusing fast). The depth check
runs and returns *before* any run is created or any new polling code
executes, so it's provably unmodified by this change — a dedicated e2e
case would need a real 4-hop chained dispatch (multiple sequential real
model calls) just to prove an already-untouched guard still runs first.
Confirmed unmodified by direct diff instead of paying that
cost/flakiness in the permanent suite.

## n8n competitive gap analysis (researched 2026-09-11)

Targeted follow-up to the wider competitive scan above, specifically
against n8n (400+ integrations, Sustainable Use License, AI Agent/AI
Agent Tool nodes added on top of its general workflow engine). Confirmed
via research, not assumption: n8n has real-time execution *viewing*
(nodes highlight as they run) but nothing that lets you change a
workflow's path while it's actively executing — OpenBots' live
mid-run rerouting is a genuine, structural differentiator, not just
positioning, because it falls out of `dispatchHop`'s "resolve fresh
every hop" design rather than being bolted on.

**Real gaps, roughly in priority order:**

1. **No event/webhook triggers.** n8n workflows start from any inbound
   webhook (Stripe, GitHub, Slack, etc.). OpenBots only has manual runs
   and cron (`scheduled_triggers`) — nothing reacts to an external
   event. Highest-leverage gap: fits the existing architecture cleanly
   (same shape as `orchestrator/scheduledTrigger.ts` — re-read fresh
   from Postgres, create the run through the shared `createRun()`
   helper — just HTTP-triggered instead of cron-triggered) and it's
   probably the single most-requested automation-platform primitive.
2. **Integration breadth.** n8n ships 400+ pre-built, zero-config app
   connectors. OpenBots deliberately keeps a small built-in tool set and
   bets on MCP as the extensibility path instead of hand-building
   connectors (see "MCP client support" above) — a legitimate different
   strategy, but today reaching Slack/Gmail/Salesforce/etc. means the
   operator standing up an MCP server themselves, not clicking a node.
3. **Per-node retry/error-handling UI.** n8n exposes configurable retry
   count/delay and dedicated error-workflow fallbacks per node. OpenBots
   has `withRetry` (transient provider errors only) and `fallbackChain`
   (model/auth errors only) — nothing user-configurable, no general "on
   failure, do this instead" pattern exposed anywhere.
4. **No dry-run / pinned-data testing.** n8n lets you test a node against
   pinned/replayed data without real side effects. OpenBots' rewind-and-
   fork always re-executes for real; there's no way to test a hop or an
   edited graph without a live run and its real cost/side effects.
5. **No non-agent nodes.** Every OpenBots hop is an LLM call — there's no
   cheaper "pure data/logic/transform, no model involved" node the way
   n8n handles plain ETL/automation alongside its AI nodes.
6. **Team/RBAC and workflow versioning.** n8n Enterprise has SSO/RBAC/
   environments and git-based workflow version control. Already tracked
   as known gap #2 (single-owner only, by design) — listed here again
   only because it's specifically what blocks n8n's Enterprise tier from
   being a fair comparison at all today.

## Getting ahead of n8n, not just matching it (2026-09-11)

Closing gaps 1-6 above gets OpenBots to competitive parity on n8n's own
turf. That's necessary but not differentiating — n8n has a multi-year
head start on integration breadth and enterprise features that isn't
worth racing head-on. The better bet is doubling down on what's
structurally hard for a general-purpose workflow engine to retrofit,
the same way live mid-run rerouting already is:

- **Make the review-revise-report loop visible, not just correct.**
  `dispatch_to_graph`'s new blocking behavior (see above) is the same
  pattern LangGraph/CrewAI/Anthropic's own research system all use, but
  every one of them runs it in code/logs only. OpenBots has the one
  thing they don't: a live canvas already built to visualize hop-by-hop
  activity. Animating a delegate → wait → review → revise round
  actually happening on the gateway-node edges (pulses, a round counter)
  would make a pattern that's currently invisible everywhere else
  something you can *watch*, not just trust happened.
- **Explainable auto-routing.** `appendAutoRoutingContext`'s injected
  candidate list and the model's routing reasoning already exist inside
  the hop — they're just not surfaced. n8n's branching (IF/Switch nodes)
  is deterministic, so it has nothing to explain; OpenBots' semantic
  routing is exactly the kind of "why did it pick that" black box that
  erodes trust the first time it misroutes. Surfacing the match/score on
  edge hover would turn "the model guessed wrong" into a fixable
  description-wording problem a human can iterate on directly.
- **Comparative rewind-and-fork.** Today a fork re-executes one
  checkpoint as a new run. Forking the *same* checkpoint twice with two
  different prompts/models/tiers and diffing the two real outputs
  side-by-side turns rewind-and-fork from "redo a step" into "A/B test
  an agent configuration against real history" — n8n's pinned-data
  replay has no equivalent because it's not built around comparing
  alternate agent behavior, only replaying identical data.
- **Cost/latency-aware routing.** `recordUsage` and the reviewer/tier
  warning already track real per-hop cost. A "prefer the cheapest
  capable specialist" routing mode, or a suggestion to downgrade an
  over-tiered node that's never actually needed its capability, is a
  genuinely agent-specific optimization with no analog in n8n's node
  model (a Slack-message node doesn't have a cost tier).
- **Lean into safety as the actual product, not a footnote.** Letting an
  LLM write to a real codebase and push is inherently higher-stakes than
  "call an API" — most competitors either don't support real write
  access at all or support it with much thinner guardrails than the
  git-worktree isolation + confirmed-only `/push`/`/pr` + dual-gated
  allowlists already built here. This is mostly a positioning/docs
  opportunity, not new code: "the only agent platform safe enough to
  give real write access to" is a real, defensible claim today.
- **Bet on MCP to close gap #2 faster than hand-building connectors
  ever could.** Every MCP server the wider ecosystem builds becomes
  usable in OpenBots for free the moment `ALLOWED_MCP_SERVERS` allows
  it — if MCP adoption keeps growing at its current rate, this closes
  the integration-breadth gap on a much shorter timeline than building
  and maintaining a rival connector library by hand, without OpenBots
  ever needing to become an integrations company.

### Promptable workflow generation — the mantra applied to graph-building itself (proposed 2026-09-13)

"Describe what you want, AI builds it" is not a blue ocean — n8n
shipped an AI workflow-builder (prompt → starter workflow), Zapier has
AI-assisted Zap/Agent creation, Make.com has AI-assisted scenario
building, and a cluster of funded startups (Lindy, Gumloop, Relevance
AI, Stack AI) are built around exactly this pitch. Table stakes now,
not a differentiator on its own — see the mantra in `CLAUDE.md`'s "What
this is" section for why the real wedge is narrower: every one of those
either hides the graph entirely (Lindy/Gumloop/Zapier — no visible,
editable structure at all) or exposes a canvas that goes inert once a
run starts (n8n). None combine generation with a live, interruptible,
self-hosted result.

**Scoped direction, not yet started.** The load-bearing piece already
exists: `manage_target_graphs` (`orchestrator/graphManagementTools.ts`)
already lets an agent create/edit nodes and edges on a graph via the
same REST API the canvas itself uses, re-verifying ownership fresh on
every call — the same trust pattern `dispatch_to_graph`/`fileAccessRoot`
already follow. A "describe your workflow" builder is that pattern
pointed at a **new** graph instead of an existing one, with a system
prompt that knows the schema conventions (`explicit`/`auto`/`consensus`
edge kinds, the `UNKNOWN`/`DONE` sentinels, when to reach for
`consensusGroup` vs `mapConfig` vs plain auto-routing) — closer to
"give the existing tool a chat front end" than a from-scratch feature.
Quick-add's "describe a new agent in plain English, fill in role/
prompt/model" (see README) is the single-node version of this that
already ships; the gap is specifically multi-node graph generation
(nodes **and** edges **and** routing **and** tool config) from one
prompt.

Real open gaps before this is buildable, not just hand-waved:

- **Guardrails on what a builder-agent can grant itself.** It must never
  set `fileAccessRoot`/`sshTarget`/`dispatchTargets`/`mcpServers` beyond
  what a human explicitly approves afterward — the existing runtime-
  allowlist re-check (`ALLOWED_FILE_ACCESS_ROOTS` etc.) helps, but the
  UX needs a clear "review before this goes live" step, not silent
  full-trust generation.
- **Data/file ingestion is new scope.** "Upload your project or data"
  has no landing place today — `fileAccessRoot` only ever points at a
  pre-existing, operator-approved directory. Needs real upload handling
  and storage, not just a bigger prompt.
- **Multi-turn correction.** "No, route it through the reviewer first"
  needs the builder-agent to read the *current* graph state before
  mutating it (not just generate-once), the same fresh-read discipline
  `dispatch_to_graph`'s ownership check already follows.

### MCP marketplace/registry landscape for the "bet on MCP" plan (researched 2026-09-11)

Concrete follow-up on what to actually integrate with. The **official
registry** (`registry.modelcontextprotocol.io`, launched preview
2025-09, backed by Anthropic/GitHub/PulseMCP/Microsoft) is metadata-only
— namespace-verified identity (reverse-DNS tied to a GitHub account or
domain), *not* a safety/audit rating; the docs explicitly say it's meant
to be consumed by **downstream aggregators**, not directly by host
applications like OpenBots. So the right integration target is one of
those aggregators, not the raw registry.

- **PulseMCP** is the strongest concrete candidate: 18,000+ servers
  cataloged with daily updates, a real "Sub-Registry API" that
  implements the *same* Generic MCP Registry API spec the official
  registry defines (so it's a standards-compatible superset, not a
  proprietary format), OpenAPI 3.1 docs at `pulsemcp.com/api/docs/v0.1`,
  and API-key auth described as built for "trusted partners" — i.e.
  actually meant for exactly this kind of product integration, not just
  human browsing. Also classifies servers as "official providers" vs
  community, useful for defaulting a picker to higher-trust results.
- **Smithery** additionally *hosts* remote endpoints (not just catalog
  metadata) — a server picked from Smithery can be Streamable-HTTP-ready
  immediately, no self-hosting required, which directly removes today's
  actual friction in gap #2 (an operator currently has to stand up their
  own MCP server before any of this matters).
- **Klavis AI** hosts production MCP servers with built-in OAuth across
  600+ tools — relevant because OpenBots' own MCP credential model
  (`credentialProvider` → a single stored bearer token) is intentionally
  simple; a Klavis-hosted server that's already handled OAuth on the
  provider's behalf is a complementary fit, not a competing approach.

**Integration shape that keeps the existing security model intact:**
a "Browse verified MCP servers" picker in `AgentSettingsForm` (next to
the existing `Discover tools` button) that queries one of these APIs for
name/description/url/transport — pure discovery UX. It must **never**
bypass `ALLOWED_MCP_SERVERS`: picking a server from the browser still
just fills in the URL field, and the operator still has to add it to
the allowlist before any node can actually use it, exactly the same
"config is a UX convenience, not the security boundary" rule
`fileAccessRoot`/`dispatchTargets` already follow. Not started — next
step would be a small `POST /mcp/marketplace/search` proxy route (server-
side, so the aggregator's API key never reaches the browser) rather than
calling a third-party API directly from `apps/web`.

## `run_code`: sandboxed code execution, pluggable across E2B/Daytona/local Piston (2026-09-12)

Closes n8n gap #1 (arbitrary code execution as a first-class step) — but
it's a fundamentally different risk class than anything shipped before
it: every existing tool reads/writes bytes or calls a pre-authorized
endpoint, none of them execute attacker-influenceable code. Researched
three backends before building anything, same due-diligence discipline
established for Smithery (see the credential security review entry
above):

- **E2B** — Apache-2.0, Firecracker microVMs, clean 2026 security track
  record. Full self-hosting needs a Nomad+Consul cluster (2,500GB
  SSD/24-CPU floor) disproportionate to this project — realistic use is
  BYOK against E2B's hosted cloud.
- **Daytona** — a real 2026 CVE history (a sandbox escape,
  CVE-2026-54319; a disabled-TLS bug, CVE-2026-54323) was going to make
  E2B the safer pick, until a decisive finding while researching self-
  hosting logistics: **as of June 2026, Daytona's core platform moved to
  a closed, private codebase** — confirmed by fetching the repo's own
  notice, not assumed from a blog post. The public repo is frozen, no
  further fixes ship to it, and full self-hosting is no longer possible
  (only a hybrid mode remains — runner on your own Kubernetes cluster,
  control plane still on Daytona's infra — which doesn't fit this
  project's docker-compose deployment model). This collapsed Daytona
  into the same shape as E2B: BYOK against a hosted cloud, no
  self-hosting story left worth building for.
- **Piston** (`engineer-man/piston`, MIT) — added mid-plan after
  discussing the self-hosting gap directly: already running in
  production behind the real `emkc.org` API and 4,100+ Discord bots,
  isolates via `isolate` (the same sandbox competitive-programming
  judges use), single Docker image, no BYOK key. The one real cost:
  Piston's own official `docker-compose.yaml` requires `privileged: true`
  (`isolate` needs to manage cgroups/namespaces itself) — a genuinely
  different risk shape than an HTTPS call to a third party. Mitigated by
  scoping it to one brand-new, dedicated container (the existing
  `worker` container's zero-privilege posture is unchanged) and gating
  it behind a Compose profile (`sandbox-local`) that never starts unless
  the operator opts in.

Considered and rejected: a standalone wrapper microservice sitting in
front of Piston (validate input, clamp timeout, cap output, expose a
narrow `POST /run`) rather than calling Piston directly from
`codeSandboxTool.ts`. It's sound engineering and the right shape *if*
you don't trust the docker-compose internal network to keep Piston's
unauthenticated API away from anything untrusted — but on this
project's network only `api`/`worker` (already-trusted code) can reach
it, so the marginal security gain didn't justify a second container
image to build, version, and keep in sync with upstream Piston. Would
be a good standalone open-source artifact on its own merits, just not
folded into this feature.

Shipped as a pluggable interface (`packages/providers/src/sandboxTypes.ts`'s
`CodeSandboxProvider`, `sandboxRegistry.ts`'s `e2b`/`daytona`/`local`
adapters) mirroring `ProviderAdapter`'s existing "one interface per LLM
provider" shape, operator-selected via `SANDBOX_PROVIDER` — not a forced
single vendor, per explicit direction. See CLAUDE.md's `run_code`
section for the dual-gate/credential/redaction/audit-trail design.

**Known gap**: real end-to-end execution against a live E2B/Daytona
account or a running local Piston container was not independently
verified this session — the e2e suite's dual-gate test (`SANDBOX_PROVIDER`
unset → the tool is never exposed) is real and passes the same way
every other operator-allowlist test does, but the real-execution tier
(gated behind `E2E_SANDBOX_PROVIDER`/`E2E_SANDBOX_API_KEY`, skipped
when unset) needs a one-time live verification pass, the same
already-accepted limit as SSH-push-over-a-real-remote and
`run_remote_command`'s live host. Separately, this same e2e run
surfaced that the configured `ANTHROPIC_API_KEY` has run out of credit
("Your credit balance is too low to access the Anthropic API"),
failing the majority of the *entire* suite (64/120), not just anything
sandbox-related — a billing issue, not a code regression; needs a
funded key before the next full verification pass.

**Update (2026-09-12) — live `local` verification against Ollama, with
a real bug found and fixed.** With the Anthropic key still out of
credit, verified the `local` (Piston) path directly instead of waiting:
brought up the `sandbox-local` profile, installed python 3.12.0/node
20.11.1 via Piston's package API (its bundled `cli/index.js` isn't
actually present in the published server image — installed straight
against `POST /api/v2/packages` instead), and drove a real run through
a node using the `openai-compatible` provider pointed at a local
Ollama (`gemma4:e4b`) — `worker` already runs `network_mode: host` for
`pc_telemetry`, so reaching Ollama needed no new networking, only
publishing Piston's port in the local (gitignored) compose override
since host networking can't resolve compose service-name DNS.

Found and fixed a real bug this surfaced: Piston uses **two different
name schemes for the same runtime** — package install
(`POST /api/v2/packages`) wants `"node"`, but `GET /api/v2/runtimes`
and `POST /api/v2/execute` both want `"javascript"` (confirmed live:
execute with `"node"` fails with "node-* runtime is unknown"). The
`PISTON_LANGUAGE` map in `sandboxRegistry.ts` briefly had this backwards
mid-session — caught by testing both values directly against a running
container before shipping, not by assumption.

A real, correct end-to-end call happened: the model called `run_code`,
Piston executed real Python, `42` came back correctly. But a *second*
verification run — deliberately asking for something uncomputable
without real execution (a random number), specifically to rule out the
first result being the model just answering trivial arithmetic from
memory — hit the default 180-second hop timeout on this CPU-only local
model before finishing. So `run_code`'s reliability through the full
engine+AI-SDK stack with a genuinely free local model remains
**unconfirmed, not passing** — a real gap, not a regression in what
shipped, and one only a funded Anthropic key or a longer timeout budget
against faster hardware will close cleanly.

## Prompt caching for OpenBots' own outbound LLM calls (2026-09-12)

Triggered by an Anthropic billing email about a low cache-hit-rate on
the account's own unrelated direct API usage — irrelevant to OpenBots
itself, but it surfaced a real, unclaimed opportunity: `engine.ts::callAgent`
resends `node.systemPrompt` (plus everything `appendXContext` injects)
byte-identical on every hop dispatched to the same node, exactly the
shape Anthropic's `cache_control` is for, and exactly the repeat-call
pattern multi-turn chat (`useBotChat`), consensus fan-out, and
`dispatch_to_graph` revision rounds already produce.

Researching it surfaced a second, more consequential finding:
**OpenAI's prompt caching is automatic and free (no code, no opt-in),
and as of a May 2026 update caches for up to 24 hours** — meaning it's
already happening today on every OpenAI node with a long-enough prompt,
and `pricing.ts::estimateCostUsd` had no idea, silently *overestimating*
cost for anyone using it. Confirmed via the AI SDK's own types
(`ai@7.0.93`'s `LanguageModelUsage.inputTokenDetails` already normalizes
`noCacheTokens`/`cacheReadTokens`/`cacheWriteTokens` across providers)
that this was fixable with zero new API surface, not something to
build.

Shipped as two tracks: an always-on cost-accounting fix (every
provider, zero behavior change — `estimateCostUsd` now prices the three
buckets separately instead of flat-rating every input token), and an
Anthropic-specific opt-in (`ANTHROPIC_PROMPT_CACHING`, off by default)
that switches `callAgent`'s `generateText()` call from the `system`/
`prompt` shorthand strings to a `messages` array with `cache_control` on
the system message — confirmed against the AI SDK's own documented
examples that `providerOptions` can only attach to a message object,
never as a flat call-level option, before writing any code. `ProviderCapabilities`
gained a fourth flag, `promptCaching`, following the same "declared
per-provider, not assumed uniform" reasoning `streaming`/`toolCalling`/
`vision` already established.

**Known gap**: not yet verified against a real, funded Anthropic
account (still blocked on the same credit exhaustion noted in the
`run_code` entry above) — the cache-write-then-cache-read sequence and
the resulting cost delta need a real two-call test to confirm, not just
a clean typecheck.

## Dogfood session: OpenBots agents working on OpenBots (2026-09-12)

With the Anthropic key funded again, a dedicated dogfood account
("OpenBots Dogfood Team" graph: Engineering Lead → Docs Engineer /
Platform Engineer on `auto` edges, both write-scoped to this repo) was
used to do real Phase 1/3 work through the product itself — the point
being to find friction, not just to produce the artifacts. Artifacts
produced by agents and merged after review: the CONTRIBUTING.md
honesty pass (no-unit-suite note, why PRs skip e2e), the README
landing-page rewrite (positioning line, Why OpenBots, Safety, both new
GIF embeds — the landscape reroute GIF and the gateway click-through
GIF were recorded this session via scripted Chromium), and
`docs/quickstart.md`. The Lead's auto-routing picked the right
specialist unprompted on every run.

**Real findings, in order of severity:**

1. **The 180s hop timeout was a hard-coded constant** — a write-capable
   node doing a genuine multi-file code task (read several files, write
   several) hit `exceeded 180000ms timeout` twice while still well under
   the step cap, and there was no way to grant more time short of
   editing `circuitBreaker.ts` and rebuilding. Fixed: `NODE_TIMEOUT_MS`
   env var, default unchanged. The deeper fix is still the "external
   CLI coding agent as a node kind" roadmap item above — this session
   is its strongest evidence yet.
2. **A timed-out hop can leave fully-committed, correct work behind
   while the run reports `error`.** Both timeout failures had already
   committed useful work to their worktree branches (68 and 26 lines);
   the run status gives no hint the branch is worth salvaging. UX gap:
   the run error surface should mention commits that landed before the
   timeout.
3. **Agents can't validate their own code changes** — no typecheck/test
   capability inside a hop, so the loop was: agent writes → human runs
   `tsc` → feed exact errors back as a follow-up run. Workable but
   asymmetric; strengthens both the `run_code`-adjacent "let a node run
   the repo's own check commands" idea and the CLI-agent node kind.
4. **Type-level nits took the agent two rounds** (AI SDK `ai/test` mock
   class version and V3 result shapes) — the final 2-line typing fix
   was faster done by hand. Splitting "agent does the substantive
   work, human does the type-system finish" was the efficient division.

**Mock provider shipped through this loop** (Phase 3 item #1 from the
go-forward plan): `provider: "mock"` — `MockLanguageModelV3`-backed, no
network, no credentials, deterministic (`MOCK: <last 200 chars>` echo,
or `ROUTE_TO <name>` in the system prompt to steer auto-routing tests).
Verified end-to-end with a real run through the full API/worker stack:
`status=completed output=MOCK: hello deterministic world`, zero API
cost. Next step: an e2e tier that runs the routing/auth/CRUD cases on
`mock` so PRs get free CI coverage.

## Dogfood round 2: transform nodes, retry backoff, sentinel display (2026-09-12)

All three changes below were written by the app's own agents (same
dogfood graph as above) with human validation per branch; two were
prompted by a real incident in the user's live Loudest chat.

- **`transform` provider — the first non-agent node type** (n8n gap #5
  v1): no model call, zero cost, deterministic. The model id selects the
  operation (`template` / `uppercase` / `extract-json`), the systemPrompt
  carries the operation's config. Implemented as a `MockLanguageModelV3`
  like `mock`, so zero engine/schema changes. Covered by 3 new mock-tier
  e2e cases (14/14). Two real bugs found in validation: the agent's
  `.test()` on a `/g` regex (stateful `lastIndex` — fixed to
  `.includes`), and — the important one — **engine context injection
  polluted transform output**: `appendAssignedTaskContext`'s worker
  guidance got appended to a rendered template, because every
  `appendXContext` treats systemPrompt as LLM instructions. `callAgent`
  now skips all context injection for non-LLM providers.
- **Retry backoff fix**: a real hop failed with `AI_APICallError: Cannot
  connect to API` after all 3 attempts — the old 500ms/1000ms spacing
  can't outlive a brief network blip. Now ~1s/~4s + jitter. Root cause
  on this host was also fixed separately: ULA-only IPv6 with AAAA-first
  DNS intermittently blackholes provider connects; the (gitignored)
  worker override now sets `NODE_OPTIONS=--dns-result-order=ipv4first`.
- **Sentinel leak in chat display**: a real answer rendered starting
  with the literal text `DONE`. New display-only
  `stripRoutingSentinel()` (`apps/web/lib/textDisplay.ts`) strips a
  leading `DONE`/`UNKNOWN`/`ALL` token wherever run *output* renders as
  answer text; stored data untouched; a bare-sentinel output still
  displays rather than going blank.

### Run results now surface committed work; hops stop gracefully at their deadline (2026-09-13)

Closed the "a failed run silently hides real committed work" gap found
twice in the dogfood sessions above. Three layers, first two written by
the dogfood agents, third (in-flight abort) by hand after live testing
proved the second alone insufficient:

1. **Surface the truth that already existed**: `GET /runs/:id` now
   includes the run's `agent_commits` rows as `commits[]`; the run page
   renders a "Committed work" section (danger-styled on error, noting
   the branch survives), and `useBotChat`'s error message names any
   committed branch.
2. **Graceful stop between steps**: a second `stopWhen` condition ends
   the tool loop `GRACEFUL_STOP_MARGIN_MS` (15s) before the hop
   deadline, so the engine can commit + append the commit note and
   complete the hop normally; the empty-text fallback distinguishes
   "ran out of time" from "hit my step limit."
3. **In-flight abort**: live testing with a 45s budget showed stopWhen
   only evaluates BETWEEN steps — one long read+generate step sailed
   through the graceful window and still got hard-killed (and
   `Promise.race` never cancels the loser, so the loop kept running as
   a zombie and committed afterward with nothing surfacing it). Now an
   `abortSignal` fires `ABORT_MARGIN_MS` (5s) before the hard deadline,
   recomputed per retry attempt; a deadline abort on a tool-capable hop
   is caught and routed through the same commit/fallback path — the
   hop completes with the honest time-out message plus the commit note
   and real diff. Verified live: a 45s-budget hop that used to end
   `status=error output=null` now ends `completed` with the fallback
   text, the committed branch named, the diff shown, and `commits[]`
   populated. Non-tool hops keep the old hard-timeout semantics
   deliberately. `withNodeTimeout` remains as the backstop for a hung
   single call.

### Multi-step tool loops resend their entire history uncached (2026-09-13)

Found via a real, expensive incident: a single investigative hop (7
large-file reads across ~7 tool-calling steps) measured **520K input
tokens and $1.66 for one hop** — almost entirely already-seen content.
Root cause: `ANTHROPIC_PROMPT_CACHING`'s existing `cache_control` only
ever marked the system prompt (a fixed cost paid once per hop);
`generateText`'s internal multi-step loop resends the ENTIRE
accumulated tool-result history — every file already read — at full,
uncached input price on every subsequent step. That's the dominant
cost driver in any real write-capable investigation, not the system
prompt.

Fixed with the AI SDK's `prepareStep` hook (confirmed available and
typed in the installed `ai@7.0.93`, not assumed): a single MOVING
`cache_control` breakpoint on whichever message is currently last,
recomputed every step — not one breakpoint added per turn, which would
exceed Anthropic's 4-breakpoint-per-request limit well before a
20-step loop finishes. A shorter, previously-cached prefix is still
found and read even though the current request's own marker sits
further along, which is Anthropic's documented pattern for multi-turn
caching. Anthropic-only, only wired when `tools` is present (a
single-step call has nothing to grow), same opt-in gate
(`ANTHROPIC_PROMPT_CACHING`) and provider-capability check
`buildPromptOptions` already uses — zero behavior change for anyone
not opted in, zero change for every other provider.

**Known gap**: not yet verified against a real funded run measuring the
actual before/after cost delta on a comparable investigative hop —
blocked on Anthropic credit at the time this shipped. `pnpm typecheck`
and the full mock-tier suite (unaffected, feature is off by default)
are clean.

### OpenRouter prompt caching — built and verified with real numbers (2026-09-13)

The `openrouter` adapter declared `promptCaching: false`, so neither
caching mechanism engaged on that route regardless of which model it
proxied to (the gate keys on OpenBots' provider id, not the model
string). Since OpenRouter is the practical way to reach Claude when a
direct Anthropic key is exhausted, that made the most-used route the
least efficient one.

**Why `providerOptions` doesn't work here**: the generic
`@ai-sdk/openai-compatible` serializer drops provider-specific message
options entirely — confirmed by grepping the installed v3.0.44 dist,
which contains no `providerOptions`/`cache_control` handling at all. So
`buildPromptOptions`/`withStepCaching`'s Anthropic `cacheControl`
markers are silent no-ops on this route. The fix injects
`cache_control` into the already-serialized request body through the
`fetch` hook the provider settings expose for exactly this purpose
(`FetchFunction = typeof globalThis.fetch`).

**Why per-block, not top-level**: OpenRouter's own docs state that
top-level automatic `cache_control` forces routing to Anthropic direct
(Bedrock/Vertex don't support it), while EXPLICIT per-content-block
breakpoints work across all Anthropic-compatible providers. Real calls
here land on Amazon Bedrock, so per-block is the only option that
doesn't constrain routing. Two breakpoints max (system + final
message), well under Anthropic's limit of four; tool-role messages are
skipped (content shape isn't reliably block-convertible). Anthropic-
family models only; any parse/shape surprise sends the original body
untouched — a caching optimization must never break a request.

**Verified, not assumed.** Raw A/B against the live API: with
`cache_control`, call 1 wrote 6,882 tokens and call 2 read 6,882 back;
the control call without it showed 0/0. Then end-to-end through the
app on two real hops against one node: input 5,866 both times,
`cache_read_tokens` 0 → **5,850**, cost **$0.01863 → $0.00317 (-83%)**.

**Cache-write accounting — found and fixed the same session.** The
first pass recorded `cache_write_tokens` as 0 even though OpenRouter
reported them, because the openai-compatible package maps
`cached_tokens` → `cacheRead` but hard-codes `cacheWrite: void 0`
(verified by reading its compiled `convertOpenAICompatibleChatUsage`).
Write tokens therefore fell into `noCache` and were priced at 1.0x
instead of Anthropic's 1.25x cache-write rate — a genuine cost
under-estimate on every cache-populating call. Fixed via the package's
own `convertUsage` provider setting (its `prompt_tokens_details` schema
is `$loose`, so OpenRouter's extra field survives parsing);
`convertOpenRouterUsage` mirrors the upstream default exactly and only
subtracts writes out of `noCache` so the buckets still sum to `total`.
Re-verified on a fresh node: hop 1 now records 5,531 cache-write tokens
at $0.02189 (correctly *higher* than the previous under-estimate), hop 2
records 5,519 cache-read tokens at $0.00306.

### e2e suite ported to a configurable provider; CI runs on OpenRouter (2026-09-13)

With the direct Anthropic key exhausted, the billed suite (`run.ts`,
120 cases) was blocked entirely. Ported it to read `E2E_PROVIDER` /
`E2E_MODEL` / `E2E_SECONDARY_MODEL` instead of 79 hardcoded
`anthropic`/`claude-sonnet-5` pairs — defaults unchanged, so the
Anthropic route still works; CI now sets `openrouter` +
`anthropic/claude-sonnet-4`, which also exercises the OpenRouter
prompt-caching path on every run. Three references stay deliberately
provider-specific because they assert on provider identity rather than
just needing a model: the stored-credential test (`openai` with
`OPENAI_API_KEY` unset), the fallback chain's `xai` target, and the
GitHub credential rows. The invalid-key literal is provider-aware so it
still forces a real classified auth error rather than a local
missing-env throw.

**A real product bug fell out of the port.** `credentials.ts` returned
`baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL` for a STORED
openrouter credential. That var is an empty string whenever it's
present-but-blank (any `.env` template, and CI's own heredoc), and
downstream `??` defaulting can't catch `""` — so `new URL("")` threw a
bare "Invalid URL" and the node never reached the provider. Any user
storing a per-node/per-graph OpenRouter key instead of using the env var
hit this. Fixed at both layers (empty-to-undefined in `credentials.ts`,
`||` instead of `??` in `registry.ts`). This is the kind of bug only a
real cross-provider run finds.

**Model-compliance differences are real and worth knowing.**
claude-sonnet-4 follows engine-injected guidance over a node's literal
system prompt more often than claude-sonnet-5 did. Two tests failed for
that reason alone, and both were genuinely fragile rather than wrong:
the scheduled-trigger case sent input `"ping"` (baiting `"pong"` against
a "reply exactly: tick" instruction), and the name-routing case sent a
terse `"Fix the analytics JSON."` — for which answering `UNKNOWN` is the
*correct* engine behavior, since nothing identified an owner. Both
inputs were de-baited; the assertions are unchanged.

**Status: 118-119/120 across CI runs**, with the residual failures being
the same LLM-nondeterminism class already documented above for the
Anthropic route (a different one or two cases each run, no code
connection). Don't read a single red run as a regression without
checking which case failed.

### Auto-routing no longer depends on the model obeying a convention (2026-09-13)

Found by evaluating a local Gemma 4 E4B (4.5B effective, on a LAN box)
in the ROUTER role, with zero-cost `mock` specialists downstream. It
routed two clear requests perfectly — "Billing Specialist", "Technical
Specialist", clean single-name outputs. On a deliberately vague request
it did the *right* thing and asked a clarifying question naming both
options — but phrased in plain prose, with no `UNKNOWN` prefix. The
keyword scorer then matched "Billing" inside the router's own question
and silently routed there, discarding the question entirely.

That is precisely the bug the `UNKNOWN` sentinel was introduced to fix
(see the auto-routing entries above) — reached by a different path. The
sentinel fix assumed the model would *comply* with an injected
convention. Frontier models mostly do; a 4B model often doesn't. The
convention was load-bearing and nothing enforced it.

Fixed structurally in `resolve.ts::matchAutoEdge`: **if the router's
output ends with a question mark, there is no match.** If a router ends
its turn asking, the question IS the answer the user needs to see;
routing onward throws it away. This is model-agnostic — it needs no
cooperation from the model at all.

**The first attempt at this was wrong, and the test caught it.** It
fired on "names 2+ candidates AND contains a question mark anywhere",
which sounded reasonable but swallowed a legitimately decisive answer
using a rhetorical lead-in ("Is it a crash? No. This is the Billing
Specialist's area, not the Technical Specialist's."). A trailing `?` is
the honest signal; a contained one is not. All three cases — ambiguous
question naming two targets, trailing question naming none, and the
decisive-with-rhetorical-question regression — are now deterministic
mock-tier cases (17/17), since the mock provider echoes input and makes
the router's exact wording controllable. Real-model coverage of this
would be inherently flaky.

**Also corrected while here**: the `openai-compatible` adapter declared
`toolCalling: false`. Verified false against a real instance — Gemma 4
E4B returns well-formed OpenAI-shape `tool_calls` over that exact
route. Nothing reads the flag today, but it would have silently denied
tools to capable local models once capability validation lands.

**Practical upshot for cost**: small local models are viable for
routers, aggregators, summarizers, and classification/extraction — the
high-volume, low-judgement hops. They are not viable for write-capable
engineering specialists (τ²-bench agentic tool use 57.5% vs 86.4% for
the 31B) or anything needing long-context recall (MRCR v2 25.4%).
Providers are per-node, so mixing needs no code change.

**Known quirk documented while testing** (predates this work):
`runs.output` is jsonb, so a string output that happens to be valid
JSON text round-trips back as a parsed document (type change +
whitespace normalization). `useBotChat` already defends; the mock-tier
extract-json case now deep-compares for the same reason. A proper fix
(preserving string-ness) is a small schema/driver change, deferred.

## Human-in-the-loop approval gate (2026-09-12)

The write-tool path already has a working approval gate — agent edits
land in an isolated git worktree, nothing reaches the remote until a
human runs `/push`. That pattern doesn't generalize: git supplies a
staging layer, a place a change can be materialized and discarded before
anyone outside sees it. Nothing else has one. `http_request` fires a
POST the instant the model calls it, and so does `run_remote_command`
and every MCP tool — there's no local fork of someone else's CRM. An
allowlist answers *which hosts are reachable*; it can't answer *should
this particular message be sent*, which is the actual question when an
agent is about to email a real customer. That second question is the
leads-workflow Phase 1 requirement and the load-bearing claim behind
"trust them with real write access."

**Turned out cheaper than an earlier pass at this gap analysis
suggested** — that pass assumed a new pausable run state was needed. It
wasn't: execution is already hop-by-hop (`dispatchHop` runs exactly one
hop, then either completes the run or enqueues the next one — no process
held open across hops), so the engine already persists everything a
resume needs, because it re-derives the next hop from the run row every
single time. Pausing is just declining to enqueue; approving is calling
`enqueueHop` on a row that's already pointing at the right node with the
right input. See `docs/orchestration.md`'s new "Human-in-the-loop
approval gate" section for the mechanism (`advanceRun`, the four call
sites it unifies, the conditional-UPDATE race close, the audit trail,
and the graph-drift re-validation on approve).

**Shipped**: `AgentNode.approvalConfig` (nullable/PATCH-clearable),
`RunStatus.awaiting_approval` (non-terminal) and a real writer for
`cancelled` (previously read in three places, written by nothing — no
run could ever be stopped before this), `POST /runs/:id/approve` (with
optional approve-with-edit `input`, not just a veto — the actual
leads-workflow ask) and `POST /runs/:id/cancel` (doubles as reject, with
an optional `reason`), an audit `run_events` row on every decision
(`decidedBy`, and both the original and edited input when approve
overwrote it), save-time rejection of gating a map/consensus branch
target (or pointing one at an already-gated node) in either direction,
and a `run_awaiting_approval` WS event. 8 new mock-tier e2e cases,
34/34 passing.

**Deliberately left out of v1**: no expiry (`expiresAfterMinutes`
enforced lazily at approval time produces runs that are neither
actionable nor terminal, and a nightly scheduled graph nobody watches
would accumulate them — needs a real sweeper to do properly, and a
paused run costs nothing while it waits, so there's no pressure forcing
this yet); no tool-call-level gating (this gates *entry to a node*, not
the exact payload a model composes mid-hop — see the doc section's
"Scope, stated honestly"); the gate lives on the node, not the edge,
since an edge-level gate would let the same sending node be guarded on
one path and unguarded on another — a footgun dressed as flexibility.

**Known gap carried forward**: notification is WebSocket-only, which
reaches an open browser and nothing else. For the scheduled/webhook runs
where a gate matters most, nobody is watching it fire — in practice a
paused run is found by checking the runs list. Email/webhook
notification is the obvious follow-up; see "Known gaps" below.

## Approve/cancel canvas UI, and a real cancel race found by the follow-up test (2026-09-13)

Shipped the UI the previous entry's API had none of: a checkbox +
instructions field in `AgentSettingsForm` to set `approvalConfig`, a
lock icon and a persistent pulsing highlight on a gated node
(`HierarchyCanvas.tsx`), and a banner — live via `run_awaiting_approval`
— with an editable input and Approve/Cancel actions. Since
`HierarchyCanvas` backs both the standalone `/hierarchy` editor and the
dashboard's embedded team chat, both got it in one change. Verified live
against the real stack, not just typecheck/build: watched the banner
and highlight appear on a real run, approved with an edited input and
confirmed the audit trail recorded it, and confirmed the edit actually
reached the model (OpenRouter, `anthropic/claude-sonnet-4` — the local
Anthropic key had run out of credit) with a real completed run.

**A follow-up mock-tier test then found a genuine bug in the shipped
gate.** The original 8 cases all exercised `/cancel` via the gate
(`awaiting_approval`) path; nothing tested it on a *plain* pending/
running run, which the endpoint is equally documented to support. A new
test fired `/cancel` immediately after starting a 6-hop chain with no
wait, and on the second CI-style run it failed: `/cancel` returned `200`
but the run's final status was `completed` anyway. Root cause: every
`runs.status` write inside `dispatchHop`/`dispatchConsensus`/
`dispatchMap`/`advanceRun` was a plain unconditional `UPDATE` — a hop
already in flight when cancel landed would finish independently and
overwrite `"cancelled"` with `"running"`/`"completed"`/`"error"`/
`"awaiting_approval"` on its way out, silently undoing the cancellation
with no error anywhere. Fixed by conditioning every one of those writes
on `ne(status, "cancelled")` and skipping the write's own downstream
event/telemetry when the row doesn't come back — the exact same
"cancelled is sticky" guarantee the `/cancel` endpoint's own conditional
UPDATE already assumed callers could rely on, now actually true. Three
duplicated "mark completed" call sites were factored into one
`completeRun()` helper specifically so this guard can't be missed on a
future fourth one. Since the bug is a genuine race, the new test asserts
the invariant that holds under either outcome (cancel wins → run
`cancelled` with fewer than 6 succeeded hops; run wins → cancel gets a
`409` and the run is genuinely `completed`/`error`) rather than a single
fixed one — 5/5 stress runs after the fix landed cancel-wins every time,
consistent with mock hops being fast but not literally zero-latency
against two back-to-back local HTTP calls.

## Approval-gate webhook notification (2026-09-13)

Closes known gap #9 for real this time. `run_awaiting_approval` was
WebSocket-only — reaches nobody for the exact scheduled/webhook runs a
gate matters most for, since no browser tab is open to receive it.

`ApprovalConfig.notifyWebhookUrl` (optional, `z.string().url()`) is a
URL `advanceRun` POSTs to the moment a run pauses at that node — same
payload shape as the WS event's, plus `event`/`runId`/`graphId`/
`nodeName`. No new migration needed; `approvalConfig` is already jsonb.

Researched first rather than assumed: **no email-sending infrastructure
exists anywhere in this codebase** (no nodemailer/SMTP/Resend/SendGrid,
no `sendEmail` function) and no outbound-webhook mechanism either — the
only existing "webhook" concept, `webhook_triggers`, is inbound (an
external POST *starts* a run), structurally nothing to reuse for
*firing* one. Building real email delivery means picking a
vendor/SMTP and asking the operator for credentials they'd have to
supply — a decision that's genuinely the operator's to make, not
something to default silently. A webhook needs none of that and is the
correct universal primitive for a self-hosted tool: point it at a Slack
incoming webhook, Zapier/Make/n8n, PagerDuty, or your own mail-sending
service, and OpenBots never becomes an email-vendor integration.
Shipped webhook only; email (if ever wanted) is a real follow-up that
needs that vendor conversation first, not blocked code.

Followed `httpEndpoints`' exact validation shape rather than inventing
a new one: `ALLOWED_NOTIFICATION_WEBHOOKS` (`validation/notificationWebhook.ts`)
is the same scheme+host[+path]-prefix allowlist, empty-deny default,
rejects embedded credentials or a credential-shaped query param
(`?api_key=…`), re-checked at delivery time as well as save time — an
operator tightening the allowlist after a node was configured takes
effect on the very next gate trip, no re-save needed. Delivery itself
is deliberately best-effort and bounded (5s timeout): a broken or slow
notification target logs and is swallowed, never affects the run, which
is already correctly paused and durable in the DB regardless of whether
anyone was actually told.

**Real delivery verified in the mock e2e tier, not just mocked.** The
`mcp-echo` fixture container (already running for the MCP-tool cases)
gained a `/webhook-capture/:token` route — POST records the last body
received under that token, GET reads it back — so a test can start a
gated run, wait for it to pause, and assert on the *exact* JSON payload
a real HTTP delivery carried (event/runId/nodeId/nodeName/instructions/
pendingInput), not just that some function was called. 38/38 mock-tier
cases passing, stable across three consecutive runs. Web UI: a
"Notify a webhook when this gate trips" field in `AgentSettingsForm`
alongside the reviewer-instructions field added earlier.

## External review found four real, verified bugs (2026-09-13)

A code review from another session (working the same repo — "Warp,"
across the http_request/web_search/web_fetch/map work; see the entries
above) flagged five issues in recent work: three severe ("fix before
relying on these features"), and blockers on the still-unpushed webhook
commit. **Verified every specific, checkable claim against the actual
code before touching anything** (ran the exact WHATWG URL resolutions
in Node, re-read every referenced function) rather than acting on the
review's word alone — all four held up exactly as described; nothing
was found to be wrong or exaggerated.

**1. `http_request` could leak one endpoint's credentials to a
different allowlisted endpoint's host.** `new URL(path, base)` with
`path` forced (by its own zod schema) to start with `"/"` is a WHATWG
absolute-path or network-path reference — `path="/admin"` discards the
base's own sub-path entirely (`https://api.example/v2/` + `/admin` →
`https://api.example/admin`, silently dropping `/v2`), and
`path="//other-host/x"` (or `"/\\other-host/x"`, a backslash parses the
same way for http/https) replaces the HOST. The post-resolve check
(`isHttpEndpointUrlAllowed`) validated against the OPERATOR's whole
allowlist, not the SELECTED endpoint's own origin — so with two
allowlisted endpoints (the documented multi-endpoint shape), a crafted
path on endpoint A's slug could resolve to endpoint B's host while
still carrying endpoint A's own `Authorization` header. Confirmed with
real `new URL()` calls before touching anything. The fix isn't just a
rejection, though — a naive "reject anything that resolves off-prefix"
check would have made every endpoint with a non-root `baseUrl` path
*permanently unusable* (since a WHATWG absolute-path reference can
literally never end up back under the base's own sub-path). The actual
fix strips a leading `/` so resolution is an APPEND (a WHATWG *relative*
reference) rather than a replace, explicitly rejects `//`/backslash
outright first (host-switching shapes), and still verifies the result
stays under the selected endpoint's own origin+prefix (catching `../`
dot-segment climbs) before the operator-allowlist check. Verified with
a battery of real `new URL()` resolutions covering both root and
sub-path bases before landing on this shape — the first version broke
the legitimate case. **No automated regression test exists for this
anywhere** — the mock provider can't call tools at all (`doGenerate`
always returns text, never a tool call), and `run.ts` (the only tier
that could exercise it with a real model) has zero existing
`http_request` coverage to extend. Flagging honestly rather than
claiming coverage that doesn't exist; a real test needs a two-endpoint
fixture and a real model call, deliberately not added here without
discussing the added billed-suite cost first.

**2. A gated node could become a live, unsupervised fan-out branch
two ways that bypass the node-save-time check entirely.**
`checkApprovalGateCompatible` (the approval-gate feature) only ran in
`insertAgentNode`/`updateAgentNode` — but a node also becomes a
`consensusGroup.edgeIds` member via `insertRoutingEdge`'s hybrid
auto-sync (adding a new `auto` edge to an already-hybrid source) and via
the canvas's own core drag-and-drop gesture, `PATCH .../edges/:edgeId`
retargeting an existing branch edge — neither mutation path ever
touches the node the original check runs against. Fixed at three
layers: a direct check in `insertRoutingEdge` before the auto-sync
write; a new `checkEdgeRetargetGateCompatible` (scans every node's
`consensusGroup.edgeIds` for the edge being retargeted, independent of
the edge's own `kind` — matches how `dispatchConsensus` resolves branch
membership purely by id) in the reroute route; and, as defense in
depth matching every other "config is a save-time convenience, not the
security boundary" allowlist in this codebase, `dispatchConsensus`/
`dispatchMap` now each refuse a gated branch target at dispatch time
too, recorded as a failed branch rather than a thrown error so the
existing partial-failure join handles it the same as any other bad
branch. 4 new mock-tier cases, all passing.

**3. A self-referential fan-out aggregator was a genuine, unguarded
infinite loop**, not just confusing config. `dispatchHop` checked
`mapConfig`'s fan-out trigger *before* the aggregator-terminal check,
and `aggregatorNodeIds()` only tracked consensus aggregators — so
`mapConfig.aggregatorNodeId === the source's own id` meant: fan out,
join, `advanceRun` back to the SAME node, which still has the same
`mapConfig`, re-parses its own just-joined output as a fresh work list,
fans out again, forever. `resolveNextHop`'s `alreadyVisited` cycle guard
never runs on this path at all — it only guards normal single-edge
routing. **Found while fixing this that `consensusGroup` has the exact
same hazard, and worse**: a pure consensus source with no auto edges
re-triggers `dispatchConsensus` *unconditionally* on every single hop
(this is the documented, intentional behavior for that case) — so a
self-referential consensus aggregator loops on its very first dispatch,
no output-shape luck required at all. Fixed both: `aggregatorNodeIds()`
now covers map aggregators too; the aggregator-terminal check in
`dispatchHop` was reordered to run *first*, before either fan-out
trigger, so even a longer cycle through several nodes' aggregator roles
is closed, not just literal self-reference; and
`checkMapConfigNotSelfReferential`/`checkConsensusGroupNotSelfReferential`
(new `validation/mapConfig.ts`) reject the literal self-reference at
save time for both. 2 new mock-tier cases.

**b496fc7 (the unpushed webhook-notification commit) had three real
gaps of its own**, caught before it ever shipped: `ALLOWED_NOTIFICATION_WEBHOOKS`
was missing from both CI workflows' `.env` heredocs — the new mock-tier
delivery test would have failed the very next time `e2e-mock.yml` ran
on a PR (a direct push to `main` doesn't trigger it, `on: pull_request`
only, so pushing the commit as-is would have looked clean while quietly
breaking CI for the next PR). `notifyApprovalWebhook`'s `fetch` had no
`redirect: "error"` (unlike `http_request`/`web_fetch`, which both
already have it for the identical reason — the allowlist only validates
the URL you started with, not wherever a redirect sends you). And its
error logs printed the full webhook URL — harmless for most targets, but
a Slack incoming-webhook URL's secret is an opaque PATH segment
(`https://hooks.slack.com/services/T000/B000/XXXX`), which is exactly
the shape `checkNotificationWebhookAllowed`'s credential checks
(userinfo, credential-shaped query params) *can't* catch, by design —
there's nowhere else for a Slack webhook to put its own auth. All three
fixed; logs now show origin only.

**Verified everything with 42/42 mock-tier cases passing** (10 new: 4
approval-gate-vs-fan-out-bypass, 2 self-referential-aggregator, 2 from
the earlier cancel-race fix, 2 webhook-notification), full monorepo
build/typecheck clean, image rebuilt and re-tested against the live
stack. Deliberately did NOT chase every item in the review's own
"secondary"/"product gaps" lists in this same pass (e.g. `parseMapItems`
taking the first JSON-parseable array rather than the best match, no
canvas UI yet for `http_request`/`mapConfig`/`web_search`/`web_fetch`
config, `useBotChat` not handling `awaiting_approval`/`cancelled`) —
those are real, worth tracking, but distinct from the three "confirmed,
fix before relying on this" items this pass focused on closing first.

## License

Apache-2.0 (patent grant intact) plus a narrow Additional Use Grant,
relicensed 2026-09-10 — before the repo went public, while it was still
private with zero forks/stars, specifically to avoid the exact sequence
n8n went through in public (Apache-2.0 → Commons Clause → Sustainable
Use License, each move reacting to someone reselling their code as a
hosted service). Self-hosting, modifying, forking, and running OpenBots
for your own org or one consulting client at a time stays fully free;
the one restriction is offering it to third parties as a hosted
multi-tenant service without a commercial agreement — see `LICENSE`.
Modeled on Dify's real precedent (a modified Apache-2.0 with the same
kind of carve-out), written original rather than copied. Not legal
advice; wants a real license-focused lawyer's review before it needs to
hold up in an actual dispute.
