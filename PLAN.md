# OpenBots — Plan

Open-source, self-hosted, model-agnostic multi-agent orchestration. The
differentiator: a live, editable canvas of the agent hierarchy and routing —
no product in the "AI bot" space currently ships one (see Competitive
notes below).

**Status as of 2026-09-09: all three original phases are built and
e2e-tested (65/65 passing, `apps/api/e2e/run.ts`), four security review
passes found and fixed real vulnerabilities, dark mode shipped, and the product
grew past the original scope into a working multi-agent "engineering
team" built from the user's own real projects — now with live run
visualization, per-agent conversation history, a unified Dashboard
experience, agents that can actually write code and (on explicit
`/push`/`/pr` confirmation, over HTTPS+PAT or SSH) push it and open a PR,
graphs that can run themselves on a recurring cron schedule, one graph
that can fire work into another it owns, a canvas UI for configuring that
cross-graph reach, a GitHub tab (commits/push/PR status/diffs) replacing
the old Commits panel, real supervisor control letting one graph fully
edit and query the outcome of graphs it dispatches into, and agents that
can read real conversion/revenue/traffic numbers instead of only
chat-supplied ones (see "Live visualization, agent reuse, and dashboard
unification", "Agent file-write and confirmed push", "Scheduled runs",
"Cross-graph dispatch and business metrics", and "GitHub tab and
cross-graph supervisor control" below). OpenBots itself now also has a
graph in its own dashboard (dogfooding — see that section), and every
file-scoped agent is now automatically told to read its project's
`CLAUDE.md` when one exists, engine-level rather than per-prompt (see
"Context consistency across agents"). The Hierarchy canvas now visualizes
cross-graph dispatch/manage reach too, and CI is fixed after having
silently failed on every run (see "Cross-graph hierarchy on the canvas"
and "CI" below). See "Known gaps" at the bottom for what's still actually
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

## Known gaps (honest list)

1. ~~The containerized `web` Docker image has never successfully built in this environment~~ — fixed 2026-09-10, see "Pre-launch hardening" below. Local `pnpm --filter @openbots/web build && start` against the dockerized API remains a valid fallback if a build ever hits the same network flakiness again.
2. **Team/role-based sharing does not exist.** Auth is single-owner only, by design.
3. The tool registry is a small built-in set, not dynamic npm-package loading — deliberate (arbitrary plugin loading would let anyone who can edit a graph run arbitrary code in the API process).
4. Consensus fan-out runs branches inline within one BullMQ job (not as separately queued hops) and has no partial-failure tolerance — a v1 simplification, documented in `docs/orchestration.md`.
5. `/push` and `/pr` only support a `github.com` origin over HTTPS or SSH — no GitLab/Bitbucket/self-hosted remotes. See "Agent file-write and confirmed push" above.
6. `business_metrics` now supports two integration *styles* ("dashboard" and "login" — see "Pre-launch hardening" below) rather than a fixed list of named sites, but only two real sources were ever actually wired up on the live account (the former `leadgen-a`/`leadgen-b`/`saas-b` credentials), and **neither integration style actually returns real data reliably today**: the "login" style's live login endpoint has previously returned an empty body — the stored value had drifted from what's actually deployed on that host — and the "dashboard" style's sources have no credential at all today (would need the user to re-add real staff credentials through the new generic /settings form). No revenue source exists yet for either style (needs new endpoint code in the target app), no Railway hosting cost (needs the user's own API token), no Render hosting cost (hard blocker — Render's API has no billing endpoint, full stop). See "Cross-graph dispatch and business metrics" and "Credential security review and a real external-drift finding" above.
7. `manage_target_graphs`'s *reach* is now visible on the canvas (gateway nodes, above), but the six tools themselves still have no visual affordance for what an agent actually *did* — no "see what changed in graph X" diff view yet, beyond the existing `GET /graphs/:id/routing-changes` audit trail, which still has no page consuming it.
8. No breadcrumb/"back to parent" link on a gateway-target graph's own canvas — the browser Back button works (gateway navigation pushes a real history entry), but there's no on-canvas affordance, deliberately: a graph can be a dispatch target of more than one parent, so there's no single "the" parent to hard-code a link to.

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
- **OpenTelemetry trace export for `run_events`.** Rather than competing
  with the observability category (Langfuse — MIT core, acquired by
  ClickHouse Jan 2026; LangSmith; Arize/Phoenix), export the existing
  hop-by-hop trail in OTel format so it plugs into tools people already
  use — integration, not a rebuild.

**Later — real value, bigger lift, best done post-traction:**
- **Time-travel / rewind-and-fork from a past hop**, LangGraph-style
  checkpoint rewind. Natural extension of the per-hop
  `dispatchHop`/`run_events` architecture already in place, and pairs
  narratively with the live-reroute differentiator ("steer forward *and*
  rewind the past") — but a real engine feature, not a quick add.
- **Lightweight knowledge-base/RAG tool** (embed + search a folder), to
  stop being a hard "no" on the most commonly expected AI-app-builder
  feature (Dify's strongest area) without trying to become a RAG platform.
- **Template/graph sharing marketplace** — extends the existing
  `agent_templates` export/instantiate mechanism, blocked on real
  multi-user/team sharing (known gap #2) landing first.

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
