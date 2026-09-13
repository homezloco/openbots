# Orchestration engine

## Lazy hop resolution

The engine never plans a run's whole path up front. `dispatchHop(runId)`
(`apps/api/src/orchestrator/engine.ts`) dispatches exactly one node, then
calls `resolveNextHop` (`apps/api/src/orchestrator/resolve.ts`) fresh,
using whatever the graph looks like *at that moment*, and enqueues one
BullMQ job for the next hop if there is one.

This is what makes drag-and-drop rerouting safe: editing an edge on the
canvas is just a row update. It's picked up the next time `resolveNextHop`
runs — never by reaching into or cancelling an in-flight model call.

```
while run.status == "active":
  node = run.currentNodeId
  output = await dispatch(node)              // in-flight, untouchable
  next = resolveNextHop(graph, node, output)  // reads current state
  if next == null: run.complete()
  else: run.currentNodeId = next; enqueue next hop
```

## `pinned` vs `live` run modes

- **`pinned`** (default): the graph is snapshotted into `runs.graphSnapshot`
  when the run starts. Deterministic and replayable — a routing edit made
  after the run started has no effect on it.
- **`live`**: after each in-flight model call returns, `dispatchHop`
  re-reads the current graph from Postgres and *then* calls
  `resolveNextHop`, so a canvas edit made while a hop was generating is
  picked up for the next hop. (Loading the graph only at hop *start*
  ignored mid-call reroutes — a real e2e failure.) `pinned` still uses
  the snapshot.

Default new runs to `pinned` unless you actually want live reroutes;
the live-reroute demo on the Dashboard starts in `live`.

## OpenTelemetry

Each hop is exported as an `openbots.hop` span in a trace keyed by the
run id, plus an `openbots.run` span when the run completes or errors.
Set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP HTTP, e.g. `http://localhost:4318`)
on the **worker** — that's where hops execute. Unset means a no-op; the
e2e suite does not require a collector. Span attributes are ids, node
name, provider/model, token counts — not prompt or output text.

## Rewind-and-fork

`POST /graphs/:graphId/runs/:runId/fork` with `{ fromSequence }` starts a
**new** run that re-executes that hop (same node, same hop input). Hops
before it are copied as history so the trail still reads as a pipeline;
the source run is never rewritten. Optional `mode` (`pinned` | `live`)
defaults to the source run's mode — `live` picks up canvas edits made
since the original. The run detail page has **Fork from here** on each
hop.

## Human-in-the-loop approval gate

`AgentNode.approvalConfig` (nullable, PATCH-clearable — same shape as
`consensusGroup`/`mapConfig`) pauses a run **before** that node executes,
waiting for a human to approve, edit, or cancel. It exists because the
git-worktree pattern that makes write access safe (see below) doesn't
generalize: there is no local fork of someone else's CRM, so a
`http_request`/`run_remote_command`/MCP call takes effect the instant the
model makes it. An allowlist answers *which hosts are reachable*, not
*should this particular message be sent* — this is what answers the
second question.

**Why pausing needed no new run state.** Lazy hop resolution (above)
already means the engine never holds anything in memory across hops — the
run row itself is the only checkpoint, re-read fresh by every dispatch.
`advanceRun(runId, graph, nextNodeId, nextInput)` is the one place a run
moves to its next node; it always writes `currentNodeId`/`input`
unconditionally, then decides whether to also call `enqueueHop`:

```
advanceRun(runId, graph, nextNodeId, nextInput):
  runs.currentNodeId, runs.input = nextNodeId, nextInput   // always
  if resolve(graph, nextNodeId).approvalConfig == null:
    enqueueHop(runId)                                       // normal path
  else:
    runs.status = "awaiting_approval"                       // pause
    publish(run_awaiting_approval)
```

Resuming is just the enqueue that didn't happen — `POST /runs/:id/approve`
sets `status: "pending"` (optionally overwriting `input` with an edited
value first — approve-with-edit, not just a veto) and calls `enqueueHop`
itself. No saved continuation is needed because nothing about "where to
resume" was ever held anywhere but the row. `advanceRun` is called from
all four places a run advances — `dispatchHop`'s normal routing tail,
both fan-out aggregator handoffs, and `createRun`'s entry-node dispatch
(a gated entry node begins the run already paused) — so the gate can
never be honored on some advance points and silently skipped on others.
`forkRun` inherits it for free, since re-running a checkpoint hop is
itself an "advance to this node before it runs."

**The one real constraint**: consensus and map branches run *inline*
inside a single BullMQ job (see below), with no queue boundary to pause
a branch at. A gated node can't be a fan-out branch target — rejected at
save time in both directions (gating an existing target, or pointing a
new target at an already-gated node) by
`validation/approvalGate.ts::checkApprovalGateCompatible`. Gating the
*aggregator* is fine; it dispatches through the queue like any other hop.

**`cancelled` finally has a writer.** It was read in `dispatchHop`'s
terminal-status guard, `resolve.ts`, and two web files long before
anything set it — no run could ever be stopped. `POST /runs/:id/cancel`
is valid from `awaiting_approval` (this is *reject*, with an optional
`reason`) and from `pending`/`running` (a plain stop). Rejection isn't a
separate status: it's cancelling with a reason recorded at a gate — one
conditional transition, not two near-identical ones. Honest limit: this
stops a run *between* hops. An in-flight hop is inside `generateText` in
the worker process; there's no cross-process signal to abort it
mid-flight, so a cancelled run's currently-running hop still finishes —
its *next* dequeued job simply no-ops against the terminal status.

**Races are closed with a conditional UPDATE, not read-then-write.**
Both endpoints gate their status transition on `WHERE status = <expected>`
in the same statement (`awaiting_approval` for approve;
`awaiting_approval`/`pending`/`running` for cancel) — a double-click or
two reviewers racing each other means exactly one request's UPDATE
matches and the loser gets a clear `409`, never a double-enqueued hop.

That guard alone wasn't enough, and a mock-tier test caught the gap: a
hop already in flight when `/cancel` lands finishes independently of the
cancel request, and its own `runs.status` writes (`running` at hop
start, `completed`/`error` at hop end, `advanceRun`'s move to the next
node or to `awaiting_approval`) were unconditional — so a cancel that
had *already succeeded* could be silently overwritten a moment later by
the in-flight hop finishing normally, undoing the cancellation with no
error anywhere. Every one of those writes in `engine.ts` is now itself
conditioned on `ne(status, "cancelled")`, and skips its own downstream
`publishRunEvent`/`recordRunFinished` when the row doesn't come back —
the same "cancelled is sticky" invariant the endpoint's own guard
already assumed, now actually enforced end to end. `completeRun()`
factors the three identical "mark completed" call sites in `dispatchHop`
into one place specifically so this guard can't be missed on a fourth
one added later.

**Audit trail**: every approve/cancel writes a `run_events` row
(`status: "approved" | "cancelled"`, `input`: the original proposed
input, `output: { decision, decidedBy, reason?, editedInput? }`) — the
same "human intervention in an automated run" class `routing_changes`
already makes attributable for live reroutes. Without this,
approve-with-edit would silently destroy the model's original proposal:
nobody could reconstruct what the agent wanted to send versus what a
human changed it to, which is exactly the question an audit trail exists
to answer.

**Graph drift while paused**: a `live`-mode run re-reads the graph on
every hop, so the gated node can be edited or deleted while a run sits
paused — a window that was always seconds (a live reroute mid-hop) but a
gate stretches to days. `POST /runs/:id/approve` re-validates that
`run.currentNodeId` still exists in whichever graph the run actually uses
(pinned snapshot or live) and still carries `approvalConfig` *before*
touching anything, failing with a clear message and leaving the run
paused — instead of letting `dispatchHop`'s bare `Node ... not found in
graph` surface as an opaque job failure after the enqueue already
happened.

**Notification** has two layers now. The WebSocket event
(`run_awaiting_approval`, `ws/publish.ts`) only ever reaches a browser
that's currently open, which is exactly the scheduled/webhook runs a
gate matters most for — nobody is watching. `ApprovalConfig.notifyWebhookUrl`
closes that: `advanceRun` POSTs `{event: "run_awaiting_approval", runId,
graphId, nodeId, nodeName, instructions, pendingInput}` to it the moment
the gate trips, the instant the WS event is published. Same operator-
allowlist shape as `httpEndpoints` (`ALLOWED_NOTIFICATION_WEBHOOKS`,
`validation/notificationWebhook.ts` — empty-deny, rejects embedded
credentials or a credential-shaped query param), re-checked at delivery
time as well as save time so a tightened allowlist takes effect on the
very next gate trip without needing every node re-saved. Delivery is
always best-effort and bounded (`NOTIFICATION_WEBHOOK_TIMEOUT_MS`,
5s) — a broken or slow target is logged and swallowed, never surfaced
to the run, since the pause already happened and is durable in the DB
regardless of whether anyone was told. No email sending exists in this
codebase (no SMTP/nodemailer/transactional-API dependency) — a webhook
is the interop primitive; bridging to email, Slack, PagerDuty, etc. is
on whatever the operator points the URL at.

Scope, stated honestly: this gates **entry to a node**, not individual
tool calls. The reviewer approves the input about to be handed to a
sending node, not the exact HTTP payload — that doesn't exist until the
model composes it mid-hop, and suspending inside `generateText`'s tool
loop is not something the one-hop-per-job design can express. The
intended pattern is a node whose only job is to send.

## `explicit` vs `auto` edges

- `explicit`: hard-wired. Highest-`priority` explicit edge out of a node
  wins.
- `auto`: resolved by matching the run's output against candidate target
  node **name + description** (mirrors Grok Bot's implicit delegation).
  The specialist then receives the **original user request**, not the
  router's "I'm sending this to X" essay. Explicit worker→worker
  pipelines still chain output.

### How `matchAutoEdge` decides (in order)

Everything below lives in `resolve.ts::matchAutoEdge`. The order matters:
every check before the scoring step exists to stop the scorer from
matching text that was never meant as a routing decision.

1. **`UNKNOWN` prefix → no match.** The router is saying "I can't tell".
   `appendAutoRoutingContext` (`engine.ts`) teaches every auto-routing
   node this convention.
2. **`DONE` prefix → no match.** The router already has a complete answer
   and doesn't want to hand off, even if that answer happens to name a
   specialist.
3. **Output ends with `?` → no match.** If the router ends its turn
   asking, the question *is* the answer the user needs to see. Unlike 1
   and 2 this needs no cooperation from the model, which matters: the
   sentinels only work if the model complies, and smaller models often
   don't. Measured against a local Gemma 4 E4B, which correctly asked a
   clarifying question naming both specialists, in plain prose, with no
   `UNKNOWN` prefix — the scorer then matched a name *inside the
   question* and silently routed there, discarding it. Keyed on a
   **trailing** `?` specifically: an earlier, broader version keyed on
   "names 2+ candidates and contains a `?` anywhere" and wrongly swallowed
   a decisive answer with a rhetorical lead-in ("Is it a crash? No. This
   is the Billing Specialist's area, not the Technical Specialist's.").
4. **Single candidate → take it.**
5. **Keyword-overlap scoring** over each target's name + description — a
   first pass modeled on the keyword-scoring layer of a sibling project's
   classifier (local-code's `ClassificationRouter`). Scoring
   description-only was a real bug: a lead that named "Loudest Backend
   Specialist" tied on the shared token "loudest" and the first auto edge
   (Frontend) won. Zero overlap → no match, rather than guessing.

"No match" returns `{edge: null, nextNodeId: null}`, which `dispatchHop`
already handles as "no next node → the run completes with this output" —
so a clarifying question becomes the run's answer with no extra plumbing.
All three of the non-obvious cases in step 3 are covered deterministically
in the mock-tier e2e suite (`run-mock.ts`), which can control the router's
exact wording; real-model coverage of them is inherently flaky.

## `consensus` edges (fan-out/join)

A node's `consensusGroup` marks it as a fan-out source: every edge in
`consensusGroup.edgeIds` fires concurrently with the same input, tracked
via a `fanout_batches` row. Once every branch finishes, `aggregatorNodeId`
is dispatched once with every branch's output — the engine only handles
the fan-out/join mechanics, the aggregator (an ordinary agent node) makes
the actual consensus judgment call.

`consensusGroup` can only be set via `PATCH /graphs/:id/nodes/:nodeId`,
never at node-creation time — it references edge ids, which don't exist
until the node and its edges already exist. This wasn't discovered until
the e2e suite tried to exercise consensus for the first time.

**Aggregator hops are terminal**, and `resolveNextHop` will not follow an
edge whose target is some node's `aggregatorNodeId`. Real team graphs
wired every specialist `--explicit-->` the sign-off reviewer (the
aggregator) and the reviewer `--auto-->` back to the specialists. A
single-specialist route then dumped prose onto a node whose prompt
expects a JSON array of `{nodeId, output}`, and the reviewer looped.
The reviewer only runs on ALL fan-out, with that JSON array. Explicit
specialist → reviewer edges still exist on those graphs; they are
ignored, and `computeWarnings` says so.

**Hybrid auto/consensus nodes.** `edgeIds` don't have to be `kind:
"consensus"` edges — `dispatchConsensus` resolves them purely by id, so
they can be a node's existing `auto` edges instead. A node with `auto`
edges AND a `consensusGroup` is a hybrid: `dispatchHop` only fans out when
the model's output starts with the sentinel `ALL` (taught via
`appendAutoRoutingContext` whenever `node.consensusGroup` is set — same
free-text-prefix convention as `UNKNOWN`, see the `auto` edges section
above); any other output falls through to normal single-target routing.
A node with a `consensusGroup` and *no* `auto` edges keeps the original
behavior — unconditional fan-out on every hop. This is what lets one
router (e.g. a "Lead Engineer" delegating to N project specialists)
handle both "check on project X" (single hop) and "status update for all
projects" (fan out to every branch in `consensusGroup.edgeIds`) without
being two different node types. `computeWarnings` (`warnings.ts`) flags —
non-blockingly — a hybrid node whose `consensusGroup.edgeIds` don't cover
all of its own `auto` edges, since that silently breaks the "ALL means
all of them" promise (e.g. a new specialist added and forgotten in the
fan-out set).

Branches run inline within the source's own BullMQ job (`Promise.allSettled`,
each still behind its own `withNodeTimeout`) rather than as separately
queued hops — a deliberate v1 simplification that trades per-branch job
isolation for a much simpler join.

**Partial failure is tolerated.** The aggregator still runs on whatever
branches succeeded, with a placeholder for each that failed, as long as
at least one succeeded; only a total wipeout fails the batch and the run.
This replaced the original all-or-nothing behavior after a real bug: one
slow branch timing out discarded every sibling's output — including a
genuinely useful completed one — in favor of a bare run-level error with
no output at all. Covered by the `consensus fan-out: one branch failing
doesn't discard a successful sibling's output` e2e case.

**A self-referential aggregator is an infinite loop, not just nonsense**
(found via external review, 2026-09-13). `aggregatorNodeId === source's
own id` used to have no protection at all: `dispatchHop` checked
`mapConfig`/`consensusGroup`'s fan-out TRIGGER before the aggregator-
TERMINAL check, and `aggregatorNodeIds()` (`resolve.ts`) only tracked
consensus aggregators, never map ones — so a node reached in its own
aggregator role would re-parse its just-joined output as a fresh
fan-out trigger and go again, forever (for a pure-consensus source with
no auto edges, this re-trigger is *unconditional* on every hop, not
even output-dependent). Fixed two ways: `checkMapConfigNotSelfReferential`/
`checkConsensusGroupNotSelfReferential` (`validation/mapConfig.ts`)
reject the literal self-reference at save time for either fan-out kind;
`aggregatorNodeIds()` now covers both kinds, and the aggregator-terminal
check in `dispatchHop` runs *first*, before either fan-out trigger — so
even a longer cycle through several nodes' aggregator roles (not just
literal self-reference) can't re-enter fan-out once any node in that
chain is reached as a join point.

**A gated node can become a live fan-out branch two ways a node-level
save-time check doesn't see** (same review). `checkApprovalGateCompatible`
only ran on node create/update — but a node also becomes a
`consensusGroup.edgeIds` member via `insertRoutingEdge`'s hybrid
auto-sync (a new `auto` edge on an already-hybrid source, see above) and
via `PATCH /graphs/:id/edges/:edgeId` retargeting an *existing* branch
edge onto a different node — neither mutation ever touches the node
whose config the original check runs against. Both are now checked too
(`checkEdgeRetargetGateCompatible` for the reroute path; an inline check
in `insertRoutingEdge` for the auto-sync path), and `dispatchConsensus`/
`dispatchMap` each also refuse a gated branch target at dispatch time as
defense in depth, the same "config is a save-time convenience, not the
security boundary" pattern `fileAccessRoot`/`dispatchTargets`/
`httpEndpoints` already follow.

## Per-node isolation

Every hop runs behind `withNodeTimeout` (`circuitBreaker.ts`) and as its
own BullMQ job. A hung node fails only its own run; it cannot stall
sibling nodes in the same graph or other runs sharing the worker pool.
This directly addresses the "shared-computer fragility" found in Grok Bot,
where one stuck bot could take an entire roster down (see `PLAN.md`).

## Retry policy

`callAgent` wraps its model call in `withRetry` (`retry.ts`): exponential
backoff, retrying only on 429/502/503/504 or connection-reset errors,
never on other 4xx errors (bad request, auth, not found) — the same
status-aware policy used by the retry helper in the `warpmux` project.
Without this, any transient provider hiccup fails the whole hop.

## Side-effect caveat

If a hop already executed a non-idempotent tool call (sent an email,
wrote a record) before a reroute lands, that side effect is not undone —
rerouting only ever changes what happens *after* the point it's applied.

## Write tools and git worktree isolation

A node with `write_file`/`edit_file` in its `tools[]` never writes into
the user's real checkout. The first write in a run calls
`ensureWorktree(root, nodeId, nodeName, runId)`
(`packages/providers/src/gitWorktree.ts`), which creates a `git worktree`
at `<fileAccessRoot>/.openbots/worktrees/<slug>-<runId8>/` on a fresh
`openbots/<slug>-<runId8>` branch off the repo's current HEAD. Every
`write_file`/`edit_file` call for that run's remaining hops operates only
inside that directory. `callAgent` (`engine.ts`) computes `canWrite` and
resolves the worktree *before* building the system prompt, since
`appendWriteContext` needs to know whether to inject the "your writes
auto-commit" explanation.

**Authorization is two independent checks, not one.** A node's
`fileAccessRoot` must already satisfy `ALLOWED_FILE_ACCESS_ROOTS` (the
base read allowlist — required for *any* file tool, including read-only
ones) — write tools additionally require it to satisfy
`ALLOWED_FILE_WRITE_ROOTS`, a completely separate operator allowlist
(`validation/fileAccessRoot.ts::checkWriteRootAllowed`). Both allowlists
must list the same path for a node to get write access to it; adding a
path to only one is a common way to get a confusing rejection. The read
allowlist is checked once, at node save time; the write allowlist is
*also* re-checked at tool-resolution time in `resolveTools`
(`packages/providers/src/tools.ts`), so revoking write access to a path
takes effect on that node's very next run even without editing the node.

**Commit granularity is per-hop.** `commitWorktreeChanges(worktree,
nodeName, touchedFiles)` runs once after `generateText` resolves for a
hop, gated on whether `touchedFiles` (populated by each write/edit tool's
own `execute()`, closure-scoped per `callAgent` call — fresh per
fallback-chain attempt, so a failed provider's partial writes never get
attributed to a later successful provider's commit) is non-empty.
Per-tool-call commits were considered and rejected: the AI SDK's
`stepCountIs` means a single model step can make several tool calls, so
tracking "pending commit" state across calls with concurrently-running
`execute()`s would be a real race.

**Symlink escape.** `resolveWithinRoot` isn't a lexical
`path.relative()` check — after computing the target path, it walks up
from the target to the nearest existing ancestor, `fs.realpath`s it, and
verifies that realpath is still within the root's own realpath. A
symlink inside the worktree pointing outside it would otherwise let a
write that looks contained on paper land wherever the symlink actually
points once the OS follows it. Shared between the read and write tools —
this was always a latent information-disclosure gap for `read_file`, but
arbitrary write onto a live project is a much higher-severity version of
the same bug.

**File ownership.** The api/worker containers run as the host uid, not
root — `docker-compose.yml` sets `user: "${DOCKER_UID:-1000}:${DOCKER_GID:-1000}"`
(override both in `.env` if your host user isn't 1000). Running as root
left every object the container wrote root-owned on the host, so the
human's next `git add` in their own checkout failed with "insufficient
permission for adding an object to repository database" until they
chowned it back. Because a numeric `user:` has no passwd entry to
resolve a home directory from, `HOME=/tmp` is set explicitly —
`ensureSafeDirectory` writes `git config --global`, which needs a
writable home. That call (idempotent, checked via `--get-all` first)
still runs before any git operation against a given root, or git refuses
with "detected dubious ownership." No global git identity is configured
anywhere;
`GIT_AUTHOR_NAME`/`_EMAIL`/`GIT_COMMITTER_NAME`/`_EMAIL` are set per
`git commit` child-process call instead. Files the container creates end
up root-owned on the host afterward (harmless in CI; may need `sudo` to
clean up a stale worktree locally) — cleanup is deliberately manual in
v1, since the failure mode of a background job deleting unreviewed agent
work is worse than directories accumulating.

**Not check-then-act.** `git worktree add` is called unconditionally,
never guarded by an existence check first — with `WORKER_CONCURRENCY`
defaulting to 10 and consensus fan-out running branches concurrently, two
hops can legitimately race to create the same `(runId, nodeId)`
worktree. A failure is only treated as fatal if the worktree path still
doesn't exist afterward, regardless of the specific git error text —
git's own ref/lock semantics are the real source of atomicity, not
application code. `commitWorktreeChanges` similarly retries on
`.git/index.lock` contention with backoff rather than failing outright.

## Confirmed push and PR creation (`/push`, `/pr`)

**The one non-negotiable design constraint**: the decision to push or
open a PR is made by deterministic backend code reading the human's own
literal, unprocessed chat input — never by an LLM interpreting free-form
text, and never triggered by anything in an agent's generated output or
a tool result. `POST /runs` (`apps/api/src/routes/runs.ts`) matches the
raw `input` string against `/^\/(?:push)(?:\s+(.+))?$/` and
`/^\/pr(?:\s+(.+))?$/` **before** the request ever reaches the
orchestration engine or any model. If either check instead asked a
model "did the user just approve a push," anything that model had ever
read — a file, a tool result, an earlier message — could contain text
engineered to look like approval: a direct prompt-injection path to an
irreversible, shared-system action. Never move either check later in the
pipeline, and never make it fuzzy/semantic — treat this the same way you
would treat "never build a SQL query by string-concatenating user input."

**Finding what to act on.** `agent_commits` (`{runId, graphId, nodeId,
worktreePath, branch, commitSha, pushedAt, createdAt}`) records every
commit `commitWorktreeChanges` makes, populated from `engine.ts::callAgent`
right alongside the free-text commit note it already appends to a hop's
output. `/push` with no argument targets the most recent row where
`pushedAt IS NULL`; `/push <branch>` scopes to a specific branch. `/pr`
(optionally `/pr <title>`) separately targets the most recent row where
`pushedAt IS NOT NULL` — a PR can only target a branch GitHub already
has — and checks for an already-open PR on that branch first (a
friendlier "PR #N already exists" message instead of a redundant 422
from GitHub), reading the repo's actual `default_branch` from the API
rather than assuming `main`.

**Credentials are account-scoped, not graph-scoped.** `user_credentials`
(`{userId, provider, label, encryptedKey}`, unique on `(userId,
provider)`) is deliberately separate from the graph/node-scoped
`provider_credentials` (AI model keys) — a different shape for a
different purpose. Two providers are meaningful here: `"github"` (a PAT,
used for an `https://` origin, and **always** required for `/pr`
regardless of push transport, since PR creation is a GitHub REST API
call, not a git-transport operation) and `"github_ssh_key"` (a PEM
private key, used for a `git@`/`ssh://` origin, `github.com` only).
Managed at `/settings` in the web app.

**SSH push mechanics.** `pushBranch()` restricts SSH to `github.com`
(`isGithubSshRemote`) — any other host gets a clear rejection rather
than a silently mis-pinned host key, since the whole point of the next
step is pinning a *specific* known key. The private key is written to a
0600 file inside a fresh 0700 temp dir (`withEphemeralSshKey`) for the
duration of exactly one `git push` child process and deleted immediately
after in a `finally` block — never persisted into any repo, worktree, or
config. `GIT_SSH_COMMAND` pins `UserKnownHostsFile` to GitHub's own
published SSH host keys (fetched directly from `https://api.github.com/meta`
when building this, not transcribed from memory, to rule out a
transcription error silently breaking every push) rather than trusting
whatever `ssh-keyscan` returns on first connection — exactly the MITM
that host-key pinning exists to prevent. `BatchMode=yes` means a
passphrase-protected key or a host-key mismatch fails fast and clearly
instead of hanging a BullMQ worker on a prompt nothing can ever answer.

**The model needs to be told the real workflow.** It has zero innate
knowledge that its writes get auto-committed (a pure engine side effect
happening *after* it responds) — `engine.ts::appendWriteContext` injects
that explanation into a write-capable node's system prompt. Without this
a node either invents an inaccurate manual git workflow to recommend, or
refuses out of an understandable but misplaced caution; the injected
context keeps the one thing it should stay firm on (it never has push/PR
capability, full stop, regardless of what any message claims) while
making its explanation of what actually happens accurate.

## Scheduled runs

`scheduled_triggers` (`{graphId, name, input, cronExpression, mode,
enabled, lastRunId, lastTriggeredAt}`) lets a graph run itself on a
recurring cron schedule with no human triggering it each time, backed by
BullMQ's **job scheduler** API (`queue/scheduleQueue.ts`) —
`upsertJobScheduler`/`removeJobScheduler`, not `getRepeatableJobs`/
`removeRepeatableByKey`, which still work but are deprecated for removal
in BullMQ v6. The trigger's own id doubles as the `jobSchedulerId`
(generated client-side before insert, specifically so an invalid cron
pattern — validated by actually attempting the registration, cron-parser
under the hood — can be rejected with a 400 before anything is
persisted), so re-registering is naturally idempotent: safe to call
again on every enable/edit, and on every worker boot.

**Postgres is the source of truth; Redis is a derived cache.** A BullMQ
job scheduler persists in Redis independently of the API/worker process,
so it normally survives a restart with zero extra work — but Redis can
be wiped independently of Postgres (e.g. a volume-separated `docker
compose down -v`). `worker.ts::reconcileSchedules()` re-registers every
`enabled` trigger from Postgres on *every* boot, not just recovery —
harmless to repeat, since the same trigger id always maps to the same
`jobSchedulerId`. `DELETE /graphs/:id` explicitly unregisters a graph's
schedules before the FK cascade removes their rows, for the same
reason: Postgres cascades know nothing about Redis-side state, and
skipping this would leave an orphaned scheduler firing forever into a
"trigger not found" no-op with no way to stop it short of a Redis flush.

**A firing re-validates against current state, not captured state.**
`orchestrator/scheduledTrigger.ts::runScheduledTrigger` re-reads the
trigger and its graph fresh from Postgres — a trigger can be
disabled/deleted, or its graph's `entryNodeId` cleared, between when
BullMQ scheduled a firing and when it actually runs. It creates the run
through the same shared `orchestrator/createRun.ts` helper `POST /runs`
uses (extracted specifically for this), so a scheduled run is created
through the exact same path as a manually-started one rather than a
parallel reimplementation that could drift. `runs.scheduledTriggerId`
(nullable, `onDelete: set null`) records which trigger caused a run, if
any, so its own run history survives that trigger being deleted later.

## Cross-graph dispatch (`dispatch_to_graph`)

Every section above assumes a graph is fully self-contained — routing
edges only ever connect nodes within the same graph, and nothing in the
engine could touch another graph's execution. `dispatch_to_graph`
(`apps/api/src/orchestrator/dispatchTool.ts`) is a deliberate, narrow
exception, added specifically so a "big picture" agent in one graph can
delegate real work into another graph without a human relaying it by
hand.

**Agent-as-tool (reversed 2026-09-11), bounded by a shrinking timeout
budget, not a cross-graph call stack.** The tool starts a real run in the
target graph via the same `createRun()` helper `/push` and scheduled
triggers already use, then **blocks and returns that run's real output**
— OpenAI's Agents SDK terminology fits well here: this is "agent-as-tool"
(the caller stays in charge and incorporates the result), not a
"handoff" (full conversation transfer, which is what in-graph `auto`/
`explicit` routing edges already do).

This was originally fire-and-forget, and a blocking design was
considered and rejected then for a real reason: a sub-run can take a long
time, and blocking one BullMQ worker slot on another graph's entire run
fights the async-by-default grain `write_file`/`/push` were built
around. That reasoning wasn't wrong, but it treated the choice as binary.
Research into how the rest of the industry does this (LangGraph's
supervisor pattern, CrewAI's hierarchical manager, and — most tellingly —
Anthropic's own production multi-agent research system) found that
*every one of them blocks synchronously*, Anthropic's own engineering
writeup says so explicitly ("our lead agents execute subagents
synchronously, waiting for each set of subagents to complete before
proceeding... this simplifies coordination, but creates bottlenecks"),
and none of them have a distinct "send it back for revision" primitive
either — it's uniformly just "the orchestrator calls the tool again."
OpenBots already supports that for free: each hop's `generateText` call
already allows up to `stepCountIs(20)` sequential tool calls, so a
review-then-revise round needed zero new engine primitive, only a tool
that actually returns a real result to review.

The bound that makes this safe: `engine.ts` extends a dispatch-capable
node's own hop timeout from the default 180s (`DEFAULT_NODE_TIMEOUT_MS`)
to `DISPATCH_HOP_TIMEOUT_MS` (600s) — applied at **every**
`withNodeTimeout` call site, including the per-branch call inside
`dispatchConsensus`, since a single branch carrying `dispatch_to_graph`
extends that whole fan-out round's worst case, not just its own. Each
dispatch call computes its own remaining budget from a shared
`hopDeadlineEpochMs` (threaded through `callAgent`) rather than a flat
per-call constant — a hop that calls the tool twice (original, then a
revision) must not let call 2 blow past the hop's own ceiling on top of
whatever call 1 already spent, or the whole hop hits `NodeTimeoutError`
and discards call 1's real result along with everything else. A target
still running past its call's budget degrades to
`outcome: "still_running"` (with the `runId`) rather than hanging —
`check_dispatch_status` can look it up again if asked later. `WORKER_CONCURRENCY`
(default 10) is the accepted cost of this — same tradeoff Anthropic
documents for their own synchronous subagents — a blocking dispatch
holds its own hop's worker slot for the wait, on top of the target's own
hop(s) each needing slots too; raise it if leaning on this pattern
heavily. The system prompt explicitly teaches a dispatch-capable node
this contract (`engine.ts::appendReachableGraphsContext`) — review the
result, revise (roughly 1-2 rounds, not hard-capped — the shrinking
budget is what actually bounds a runaway loop) or report it honestly,
never guess at an outcome you didn't get.

**Security: name-based resolution + fresh ownership check, no third
allowlist.** The model only ever supplies a graph **name** in its tool
call — never a raw id — matched server-side against
`getDispatchableGraphs(ownerId, node.dispatchTargets)`, which itself
re-queries `agentGraphs` filtered to `ownerId === callingGraph.ownerId`
on every single call. Even a fully prompt-injected tool call can at
absolute worst dispatch to a graph already in that node's own
`dispatchTargets` — never anything else, regardless of what arguments
it's given. `dispatchTargets` (a per-node allowlist, mirroring
`fileAccessRoot`'s dual-gate: the tool name in `tools[]` alone grants
nothing without this also being configured, and vice versa) is a
save-time UX convenience only, validated by
`validation/dispatchTargets.ts::checkDispatchTargetsOwned` — the real
boundary is the ownership check re-run fresh inside `execute()` itself.
A third, *operator*-level allowlist (analogous to
`ALLOWED_FILE_ACCESS_ROOTS`) was considered and rejected: filesystem
paths are an open, unbounded namespace that needs an operator ceiling
above any one user; graph ids are already a closed, per-owner-scoped
namespace in this single-owner self-hosted shape, so the same-owner
check already is the ceiling. Revisit only if OpenBots ever adds team/
multi-tenant sharing.

**Cross-graph dispatch cycles are a genuinely new risk this tool
introduces.** Before it, nothing could touch another graph's execution,
so nothing needed a cycle guard. Graph A dispatching into B whose own
Lead dispatches back into A has no natural stopping point otherwise,
since each hop is fire-and-forget with no call stack to unwind.
`runs.dispatchDepth` (incremented by one on every dispatch, checked
against a small `MAX_DISPATCH_DEPTH` constant before a new dispatch is
allowed to proceed) is a required part of the tool's design, not an
afterthought.

**Layering**: `dispatch_to_graph` and `business_metrics`
(`orchestrator/businessMetricsTool.ts`) both live in `apps/api`, not
`packages/providers/src/tools.ts` — they need `db`/`createRun`/
`decryptCredential`, all `apps/api`-only, and `packages/providers` must
never depend on `apps/api` (the same rule the write-root allowlist check
already follows). `resolveTools()` silently skips any tool name it
doesn't recognize, so `engine.ts::callAgent` merges both into the
resolved tool set by hand after calling it, rather than teaching the
shared package about `apps/api` internals.
