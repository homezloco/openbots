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
- **`live`**: `resolveNextHop` reads the current graph from Postgres on
  every hop, so canvas edits affect the run immediately (on its next hop).

Ship and default to `pinned` first; treat `live` as an opt-in per-run flag
once the lazy-resolution loop above is proven in practice.

## `explicit` vs `auto` edges

- `explicit`: hard-wired. Highest-`priority` explicit edge out of a node
  wins.
- `auto`: resolved by matching the run's output against candidate target
  node `description` fields (mirrors Grok Bot's implicit delegation).
  `matchAutoEdge` in `resolve.ts` currently does keyword-overlap scoring —
  a first pass modeled on the keyword-scoring layer of a sibling project's
  classifier (local-code's `ClassificationRouter`), which layers keyword
  scoring -> a trained classifier -> learned corrections -> an LLM
  fallback. Add later layers here before relying on `auto` edges for
  anything ambiguous in production.

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
