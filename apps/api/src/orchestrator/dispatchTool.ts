import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs, runs } from "../db/schema.js";
import { createRun } from "./createRun.js";

/**
 * Cross-graph dispatch cycles are a genuinely new risk this tool
 * introduces — nothing in OpenBots could touch another graph's execution
 * before it. Graph A dispatching into B, whose own Lead dispatches back
 * into A, would otherwise recurse with no natural stopping point (each
 * hop is fire-and-forget, so there's no call stack to unwind). This is a
 * required deliverable of the tool, not a nice-to-have.
 */
const MAX_DISPATCH_DEPTH = 3;

export interface DispatchableGraph {
  id: string;
  name: string;
  description: string;
}

/**
 * The graphs a dispatch-capable node may actually fire into right now —
 * re-verified against live ownership, never trusted from whatever
 * dispatchTargets said at node-save time. Used both to build the tool's
 * own runtime allowlist and to tell the model what it can see (see
 * engine.ts::appendDispatchContext).
 */
export async function getDispatchableGraphs(
  ownerId: string | null,
  dispatchTargets: string[] | null | undefined,
): Promise<DispatchableGraph[]> {
  if (!ownerId || !dispatchTargets || dispatchTargets.length === 0) return [];
  const rows = await db.query.agentGraphs.findMany({
    where: and(inArray(agentGraphs.id, dispatchTargets), eq(agentGraphs.ownerId, ownerId)),
  });
  return rows.map((g) => ({ id: g.id, name: g.name, description: g.description }));
}

/**
 * Fire-and-forget: starts a real run in another graph the calling node is
 * explicitly allowed to dispatch into, and returns immediately without
 * waiting for it to finish. The model only ever supplies a graph NAME,
 * matched against a pre-authorized, pre-filtered candidate list computed
 * server-side — even a fully prompt-injected tool call can at absolute
 * worst dispatch to a graph already in this node's own dispatchTargets,
 * never anything else, regardless of what arguments it's given.
 *
 * ownerId/dispatchTargets/callerRunId are bound in by the caller
 * (engine.ts::callAgent) at tool-resolution time, not supplied by the
 * model — the same "resolve the trust boundary in the caller, not from
 * anything the model provides" pattern the write tools already follow.
 */
export function createDispatchToGraphTool(ownerId: string | null, dispatchTargets: string[], callerRunId: string): Tool {
  return tool({
    description:
      "Start a new, independent run in another one of your graphs. This is fire-and-forget: " +
      "it returns as soon as the run is CREATED, it does NOT wait for or return that run's " +
      "result. After calling this, tell the user you've dispatched the work — you will never " +
      "see that run's actual output yourself, so never describe or guess at its outcome.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      input: z.string().describe("The task or message to send as that graph's run input"),
    }),
    execute: async ({ targetGraphName, input }) => {
      if (!ownerId || dispatchTargets.length === 0) {
        return { error: "This agent has no configured dispatch targets." };
      }

      // Re-verified fresh on every call against live ownership — never
      // trusts whatever dispatchTargets said when the node was last saved.
      const candidates = await getDispatchableGraphs(ownerId, dispatchTargets);
      const target = candidates.find((g) => g.name.trim().toLowerCase() === targetGraphName.trim().toLowerCase());
      if (!target) {
        const names = candidates.map((g) => g.name).join(", ") || "(none)";
        return { error: `No dispatchable graph named "${targetGraphName}". Valid targets: ${names}` };
      }

      const targetRow = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, target.id) });
      if (!targetRow) return { error: `"${target.name}" no longer exists.` };
      if (!targetRow.entryNodeId) return { error: `"${target.name}" has no entry node configured yet.` };

      const callerRun = await db.query.runs.findFirst({ where: eq(runs.id, callerRunId) });
      const depth = (callerRun?.dispatchDepth ?? 0) + 1;
      if (depth > MAX_DISPATCH_DEPTH) {
        return { error: "Dispatch depth limit reached — this looks like a dispatch cycle between graphs; refusing." };
      }

      const run = await createRun(targetRow, input, "pinned", undefined, depth);
      return {
        dispatched: true,
        targetGraph: target.name,
        runId: run.id,
        message: `Dispatched to ${target.name} — run ${run.id} started.`,
      };
    },
  });
}
