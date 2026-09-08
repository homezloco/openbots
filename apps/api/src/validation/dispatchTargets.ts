import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs } from "../db/schema.js";

const DISPATCH_TOOL_NAME = "dispatch_to_graph";

/**
 * A cross-field check, not a per-field zod schema: whether dispatchTargets
 * matters depends on `tools`, and either field may be absent from a PATCH
 * body (partial update — the effective value could come from the
 * already-stored row). Callers resolve the effective (post-merge, for
 * PATCH) values before calling this, same convention as
 * checkWriteRootAllowed. Returns an error message, or null if fine.
 *
 * This is a save-time convenience only — the real security boundary is
 * re-checked fresh against ownership inside the tool's own execute() on
 * every call (orchestrator/dispatchTool.ts), never trusted from here.
 */
export async function checkDispatchTargetsOwned(
  tools: string[] | undefined,
  dispatchTargets: string[] | null | undefined,
  ownerId: string | null,
): Promise<string | null> {
  const wantsDispatch = tools?.includes(DISPATCH_TOOL_NAME);
  if (!wantsDispatch) return null;
  if (!dispatchTargets || dispatchTargets.length === 0) {
    return "dispatchTargets is required when tools includes dispatch_to_graph";
  }

  const owned = await db.query.agentGraphs.findMany({
    where: and(inArray(agentGraphs.id, dispatchTargets), eq(agentGraphs.ownerId, ownerId ?? "")),
  });
  if (owned.length !== dispatchTargets.length) {
    return "dispatchTargets can only reference graphs you own";
  }
  return null;
}
