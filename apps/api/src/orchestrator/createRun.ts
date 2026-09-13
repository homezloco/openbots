import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import type { agentGraphs } from "../db/schema.js";
import { runEvents, runs } from "../db/schema.js";
import { advanceRun, loadLiveGraph } from "./engine.js";

type AgentGraphRow = typeof agentGraphs.$inferSelect;

/**
 * Shared by POST /runs and the scheduled-trigger worker (orchestrator/
 * scheduledTrigger.ts) so a scheduled run behaves identically to a
 * manually-started one. Callers own their own validation (ownership,
 * graphRow.entryNodeId being set) before calling this.
 */
export async function createRun(
  graphRow: AgentGraphRow,
  input: unknown,
  mode: "pinned" | "live",
  scheduledTriggerId?: string,
  dispatchDepth = 0,
  dispatchSourceGraphId?: string,
  webhookTriggerId?: string,
) {
  const graph = await loadLiveGraph(graphRow.id);

  const [run] = await db
    .insert(runs)
    .values({
      graphId: graphRow.id,
      mode,
      graphSnapshot: mode === "pinned" ? graph : null,
      status: "pending",
      currentNodeId: graphRow.entryNodeId,
      input,
      scheduledTriggerId: scheduledTriggerId ?? null,
      dispatchDepth,
      dispatchSourceGraphId: dispatchSourceGraphId ?? null,
      webhookTriggerId: webhookTriggerId ?? null,
    })
    .returning();

  // Reuses the same enqueue-vs-pause decision every other advance point
  // makes: a gated entry node means the run begins paused instead of
  // dispatching immediately. Redundantly re-writes currentNodeId/input to
  // the values just inserted above, which is harmless — the point is the
  // decision logic, not the write.
  await advanceRun(run.id, graph, graphRow.entryNodeId!, input);
  return run;
}

/**
 * Rewind-and-fork: a new run that re-executes `fromSequence` of `source`
 * with that hop's original input. Prefix hops are copied as history (not
 * re-run). The source run is never mutated — same idea as live reroute
 * (steer the next hop) but for the past.
 */
export async function forkRun(
  source: typeof runs.$inferSelect,
  fromSequence: number,
  mode: "pinned" | "live",
) {
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, source.id)).orderBy(runEvents.sequence);
  const checkpoint = events.find((e) => e.sequence === fromSequence);
  if (!checkpoint) {
    throw Object.assign(new Error(`No hop at sequence ${fromSequence}`), { statusCode: 404 });
  }

  const graph = await loadLiveGraph(source.graphId);
  const snapshot = mode === "pinned" ? (source.graphSnapshot ?? graph) : null;

  const [fork] = await db
    .insert(runs)
    .values({
      graphId: source.graphId,
      mode,
      graphSnapshot: snapshot,
      status: "pending",
      currentNodeId: checkpoint.nodeId,
      input: checkpoint.input,
      forkedFromRunId: source.id,
      forkedFromSequence: fromSequence,
      dispatchDepth: source.dispatchDepth,
      dispatchSourceGraphId: source.dispatchSourceGraphId,
    })
    .returning();

  const prefix = events.filter((e) => e.sequence < fromSequence);
  if (prefix.length > 0) {
    await db.insert(runEvents).values(
      prefix.map((e) => ({
        runId: fork.id,
        nodeId: e.nodeId,
        sequence: e.sequence,
        status: e.status,
        resolvedEdgeId: e.resolvedEdgeId,
        fanoutBatchId: null,
        input: e.input,
        output: e.output,
        error: e.error,
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
      })),
    );
  }

  // Re-running checkpoint.nodeId is itself an "advance to this node before
  // it runs" — if that node has since been gated (or already was), the
  // fork inherits the pause for free, same helper as createRun's entry
  // dispatch above.
  await advanceRun(fork.id, graph, checkpoint.nodeId, checkpoint.input);
  return fork;
}
