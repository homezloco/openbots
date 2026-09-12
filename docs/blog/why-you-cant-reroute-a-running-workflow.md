# Why you can't reroute a running n8n workflow (and why you can in OpenBots)

Every workflow engine can show you a run happening. n8n highlights nodes
as they execute. LangGraph and CrewAI stream logs. Grok's dashboard
sorts sessions by state. What none of them let you do is *change the
path of a run that's already executing* — drag an edge while a step is
mid-flight and have the very next step follow the new route.

OpenBots does, and the interesting part isn't the feature. It's why the
usual architecture makes this nearly impossible to retrofit, and why a
different (arguably lazier) design gets it for free.

## The plan-ahead trap

Most workflow engines compile a run before executing it. When you hit
"run" in n8n, the engine takes the workflow definition and walks it: it
knows the whole DAG up front, schedules nodes whose inputs are
satisfied, and treats the definition as immutable for the lifetime of
the execution. Editing the workflow while it runs is safe precisely
because the running execution never looks at the definition again —
your edit applies to the *next* run.

That's a sound design with real benefits: the engine can validate the
whole graph up front, parallelize aggressively, and reason about
completion. But it hard-codes an assumption — *the plan is fixed at
start* — so deeply that "change the route mid-run" isn't a missing
feature, it's a contradiction. You'd need the executor to re-consult a
mutable definition at every step boundary, invalidate its scheduling
decisions, and reconcile in-flight work against a graph that no longer
matches. For a general-purpose engine with fan-in joins and branch
merging, that's a rewrite, not a patch.

## The per-hop alternative

OpenBots' orchestration engine never plans a run ahead of time. The
entire engine is one function that dispatches exactly one step:

1. Load the run. Look up which node it's currently on.
2. Call that node's model (with its tools, timeout, and isolation).
3. **After** the call returns, read the graph *fresh from the database*
   and resolve where to go next.
4. Enqueue one job for that next hop — or complete the run if there
   isn't one.

There is no function anywhere that computes a run's full path. The
route exists only one hop at a time, resolved against whatever the
graph looks like *at that moment*.

Which means "drag an edge while a run is executing" isn't special-cased
anywhere. A drag is just a row update on the edge. The in-flight model
call is never cancelled or interrupted — when it returns, step 3 reads
the graph, sees the edge now points at Billing instead of Support, and
the next hop goes to Billing. The README GIF is a real recording of
exactly this, not a mock-up.

Two details matter for correctness:

- **The re-read happens after the model call, not before it.** An
  earlier version loaded the graph once at the top of the hop, which
  silently ignored any reroute made during generation — the exact
  window a human watching the canvas actually uses. The e2e suite has a
  case that fires a reroute inside that window and asserts the next hop
  changes.
- **You can opt out.** Runs default to `pinned` mode, which snapshots
  the graph at creation and ignores every later edit — the plan-ahead
  behavior, when you want reproducibility. `live` mode is the one that
  re-resolves per hop. The difference is one column on the run row,
  because re-resolving fresh is the engine's natural behavior; pinning
  is the special case. In a plan-ahead engine, the polarity is
  reversed, and that reversal is the whole ballgame.

## What it costs

Honesty requires the trade-offs:

- **No global lookahead.** The engine can't tell you a run's remaining
  path, because there isn't one until each hop resolves. Warnings about
  suspicious graph shapes run at edit time instead.
- **Routing is resolved per hop, one target at a time.** Fanning out to
  N branches exists (consensus groups), but it's a deliberate,
  configured join — not something an optimizer discovered by analyzing
  the DAG.
- **A cycle guard is mandatory.** With no precomputed plan, nothing
  structurally prevents A→B→A. The engine tracks visited nodes per run
  and completes the run when a hop resolves to a node that already ran.

For LLM agents, these costs are cheap. Agent routing is *semantic* — a
router node's output decides where to go, and that output doesn't exist
until the model generates it. A plan-ahead engine has to model that as
"conditional branches enumerated in advance." A per-hop engine just...
resolves the hop. The architecture that makes mid-run rerouting trivial
is the same one that makes semantic routing natural.

## Steering as a first-class interaction

The deeper point isn't rerouting for its own sake. Multi-agent runs are
long, expensive, and occasionally wrong in ways you can see coming.
Today's tools give you two options when you watch an agent head down
the wrong path: kill the run and lose the work, or let it finish and
pay for the mistake. A live canvas over a per-hop engine gives you a
third: steer it. Add a specialist and wire it in while the supervisor
is still thinking. Drag the next hop somewhere else. Watch the pulse
follow your change.

That interaction can't be bolted onto an engine that already knows
where the run is going. It has to fall out of an engine that doesn't.

---

*OpenBots is open-source, self-hosted, model-agnostic multi-agent
orchestration — see the [repo](https://github.com/homezloco/openbots)
and [docs/orchestration.md](../orchestration.md) for the engine
internals described here.*
