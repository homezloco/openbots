import { db } from "../db/client.js";
import type { agentGraphs } from "../db/schema.js";
import { runs } from "../db/schema.js";
import { enqueueHop } from "../queue/runQueue.js";
import { loadLiveGraph } from "./engine.js";

type AgentGraphRow = typeof agentGraphs.$inferSelect;

/**
 * Shared by POST /runs and the scheduled-trigger worker (orchestrator/
 * scheduledTrigger.ts) so a scheduled run behaves identically to a
 * manually-started one. Callers own their own validation (ownership,
 * graphRow.entryNodeId being set) before calling this.
 */
export async function createRun(graphRow: AgentGraphRow, input: unknown, mode: "pinned" | "live") {
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
    })
    .returning();

  await enqueueHop(run.id);
  return run;
}
