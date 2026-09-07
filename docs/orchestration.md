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
