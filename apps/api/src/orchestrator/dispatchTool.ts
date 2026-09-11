import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs, runEvents, runs } from "../db/schema.js";
import { createRun } from "./createRun.js";

/**
 * Cross-graph dispatch cycles are a genuinely new risk this tool
 * introduces — nothing in OpenBots could touch another graph's execution
 * before it. Graph A dispatching into B, whose own Lead dispatches back
 * into A, would otherwise recurse with no natural stopping point. This is
 * a required deliverable of the tool, not a nice-to-have — it holds
 * whether a dispatch blocks for the result or not.
 */
const MAX_DISPATCH_DEPTH = 3;

/**
 * Extended per-hop timeout for a node that blocks waiting on a dispatched
 * run (see engine.ts). 10 minutes, provisional — like DEFAULT_NODE_TIMEOUT_MS
 * itself, tune from real measurement, not guesswork.
 */
export const DISPATCH_HOP_TIMEOUT_MS = 600_000;

/** Per-call wait budget, overridable for deterministic e2e testing of the timeout-fallback path. */
const DEFAULT_DISPATCH_POLL_TIMEOUT_MS = Number(process.env.DISPATCH_POLL_TIMEOUT_MS ?? 480_000);
const DISPATCH_POLL_INTERVAL_MS = 2_000;
/** Headroom left for the model's own reasoning/generation after a dispatch call returns. */
const DISPATCH_SAFETY_MARGIN_MS = 20_000;

const MAX_OUTPUT_CHARS = 2000;

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
 * engine.ts::appendReachableGraphsContext).
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

/** Shared by dispatch_to_graph's wait loop and check_dispatch_status: runs.output is only ever set on success. */
export function summarizeRunOutput(output: unknown, maxChars = MAX_OUTPUT_CHARS): string {
  const str = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return str.length > maxChars ? `${str.slice(0, maxChars)}\n[...truncated]` : str;
}

/**
 * A failed run's own `runs.output` is null — only ever set on success —
 * so the actual error text lives one query away, on the failed hop's
 * runEvents row. Without this, a `status: "error"` result gives the
 * model nothing to actually review.
 */
async function fetchFailureDetail(runId: string): Promise<string | null> {
  const [failedHop] = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.status, "failed")))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  return failedHop?.error ?? null;
}

type DispatchWaitResult =
  | { outcome: "completed"; output: string }
  | { outcome: "failed"; error: string }
  | { outcome: "still_running" };

/**
 * Polls the specific run just created, by id — not check_dispatch_status's
 * graphId+dispatchSourceGraphId/most-recent-by-createdAt query, which is
 * ambiguous the moment the same node dispatches into the same target
 * twice (exactly what a revision call does). Budget is wall-clock
 * (Date.now()-based), not iteration count, so it composes correctly with
 * the shrinking per-call budget engine.ts computes for a second call in
 * the same hop.
 */
async function waitForDispatchedRun(runId: string, budgetMs: number): Promise<DispatchWaitResult> {
  const deadline = Date.now() + Math.max(budgetMs, 0);
  while (true) {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run?.status === "completed") return { outcome: "completed", output: summarizeRunOutput(run.output) };
    if (run?.status === "error") {
      const detail = await fetchFailureDetail(runId);
      return { outcome: "failed", error: detail ?? "The dispatched run failed with no recorded error detail." };
    }
    if (Date.now() >= deadline) return { outcome: "still_running" };
    await new Promise((resolve) => setTimeout(resolve, DISPATCH_POLL_INTERVAL_MS));
  }
}

/**
 * Agent-as-tool, not a handoff (OpenAI Agents SDK's terms): the calling
 * node stays in charge, blocks on the target run's real result, and
 * incorporates it into its own reasoning — never hands the conversation
 * over. Bounded by a shrinking per-hop budget (see engine.ts's
 * hopDeadlineEpochMs) so a dispatch can never hold a worker slot
 * indefinitely; a target that's still running past that budget degrades
 * to `outcome: "still_running"` rather than hanging, and
 * check_dispatch_status can pick up the answer later.
 *
 * The model only ever supplies a graph NAME, matched against a
 * pre-authorized, pre-filtered candidate list computed server-side — even
 * a fully prompt-injected tool call can at absolute worst dispatch to a
 * graph already in this node's own dispatchTargets, never anything else,
 * regardless of what arguments it's given.
 *
 * ownerId/dispatchTargets/callerRunId/callingGraphId/hopDeadlineEpochMs
 * are bound in by the caller (engine.ts::callAgent) at tool-resolution
 * time, not supplied by the model — the same "resolve the trust boundary
 * in the caller, not from anything the model provides" pattern the write
 * tools already follow.
 */
export function createDispatchToGraphTool(
  ownerId: string | null,
  dispatchTargets: string[],
  callerRunId: string,
  callingGraphId: string,
  hopDeadlineEpochMs: number,
): Tool {
  return tool({
    description:
      "Start a new run in another one of your graphs and WAIT for its real result — this call blocks, " +
      "bounded by a timeout, and returns what that graph actually produced. Review the result: if it's " +
      "incomplete or wrong, you may call this again with revised, fully self-contained instructions to " +
      "get another pass (each call starts a brand-new run with NO memory of any earlier dispatch, so " +
      "restate the full task plus what needs to change — don't just say 'try again'). Keep it to roughly " +
      "1-2 revision rounds before reporting back to the user with whatever you have. If the target is still " +
      "running when the timeout is reached, you'll get outcome: \"still_running\" with a runId — tell the " +
      "user honestly that it's still in progress rather than guessing at an answer; check_dispatch_status " +
      "can look it up again later.",
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

      const run = await createRun(targetRow, input, "pinned", undefined, depth, callingGraphId);

      const budgetMs = Math.min(DEFAULT_DISPATCH_POLL_TIMEOUT_MS, hopDeadlineEpochMs - Date.now() - DISPATCH_SAFETY_MARGIN_MS);
      const result = await waitForDispatchedRun(run.id, budgetMs);

      if (result.outcome === "completed") {
        return { outcome: "completed", targetGraph: target.name, runId: run.id, output: result.output };
      }
      if (result.outcome === "failed") {
        return { outcome: "failed", targetGraph: target.name, runId: run.id, error: result.error };
      }
      return {
        outcome: "still_running",
        targetGraph: target.name,
        runId: run.id,
        message: `${target.name} is still working on this — tell the user it's still in progress, not the answer.`,
      };
    },
  });
}

/**
 * Read-only companion to dispatch_to_graph: lets a dispatch-capable node
 * check on a run IT PREVIOUSLY dispatched, on demand — mainly useful now
 * for the `still_running` fallback case, or a sibling node checking on a
 * dispatch another hop started. Bound with the same
 * ownerId/dispatchTargets the dispatch tool receives (identical trust
 * boundary, re-verified fresh via getDispatchableGraphs on every call)
 * plus callingGraphId, so this can only ever surface runs THIS graph
 * itself dispatched — not just any run that happens to exist in a
 * reachable graph.
 */
export function createCheckDispatchStatusTool(
  ownerId: string | null,
  dispatchTargets: string[],
  callingGraphId: string,
): Tool {
  return tool({
    description:
      "Check the status/result of a run you previously started with dispatch_to_graph into one of your target graphs — " +
      "mainly useful when an earlier dispatch call returned outcome: \"still_running\" and you're asked about it later.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
    }),
    execute: async ({ targetGraphName }) => {
      if (!ownerId || dispatchTargets.length === 0) {
        return { error: "This agent has no configured dispatch targets." };
      }

      const candidates = await getDispatchableGraphs(ownerId, dispatchTargets);
      const target = candidates.find((g) => g.name.trim().toLowerCase() === targetGraphName.trim().toLowerCase());
      if (!target) {
        const names = candidates.map((g) => g.name).join(", ") || "(none)";
        return { error: `No dispatchable graph named "${targetGraphName}". Valid targets: ${names}` };
      }

      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.graphId, target.id), eq(runs.dispatchSourceGraphId, callingGraphId)))
        .orderBy(desc(runs.createdAt))
        .limit(1);

      if (!run) {
        return { error: `Nothing has been dispatched into "${target.name}" from here yet.` };
      }

      const failureDetail = run.status === "error" ? await fetchFailureDetail(run.id) : null;

      return {
        targetGraph: target.name,
        status: run.status,
        output: summarizeRunOutput(run.output),
        error: failureDetail,
        startedAt: run.createdAt,
        completedAt: run.completedAt,
      };
    },
  });
}
