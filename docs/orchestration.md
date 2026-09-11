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

## `explicit` vs `auto` edges

- `explicit`: hard-wired. Highest-`priority` explicit edge out of a node
  wins.
- `auto`: resolved by matching the run's output against candidate target
  node **name + description** (mirrors Grok Bot's implicit delegation).
  `matchAutoEdge` in `resolve.ts` currently does keyword-overlap scoring —
  a first pass modeled on the keyword-scoring layer of a sibling project's
  classifier (local-code's `ClassificationRouter`). Scoring description-only
  was a real bug: a lead that named "Loudest Backend Specialist" tied on
  the shared token "loudest" and the first auto edge (Frontend) won. The
  specialist then receives the **original user request**, not the router's
  "I'm sending this to X" essay. Explicit worker→worker pipelines still
  chain output.

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
isolation for a much simpler join. v1 also has no partial-failure
tolerance: any branch failing fails the whole batch and the run, rather
than letting the aggregator judge on a subset.

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

**Root-owned files.** The container runs as root (`apps/api/Dockerfile`,
no `USER` directive) while host-mounted project directories are owned by
the host user — `ensureSafeDirectory` runs `git config --global --add
safe.directory <root>` (idempotent, checked via `--get-all` first) before
any git operation against a given root, or git refuses with "detected
dubious ownership." No global git identity is configured anywhere;
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

**Fire-and-forget, not a cross-graph call stack.** The tool starts a real
run in the target graph via the same `createRun()` helper `/push` and
scheduled triggers already use, and returns immediately with
`{dispatched, runId, message}` — it never waits for or sees that run's
actual output. A synchronous "call another graph and block for its
result" design was considered and rejected: a sub-run can take a long
time (especially a consensus fan-out one), and blocking one BullMQ
worker slot on another graph's entire run fights the same
async-by-default grain `write_file`/`/push` were built around. The
system prompt explicitly teaches a dispatch-capable node this contract
(`engine.ts::appendDispatchContext`) so it never describes or guesses at
a dispatched run's outcome — the same honesty instinct
`appendWriteContext`'s "never claim you pushed" already establishes.

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
