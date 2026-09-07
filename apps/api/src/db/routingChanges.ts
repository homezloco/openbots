import { eq, sql } from "drizzle-orm";
import type { RoutingChangeType } from "@openbots/graph-schema";
import { db } from "./client.js";
import { agentGraphs, routingChanges } from "./schema.js";

/**
 * Every node/edge mutation goes through here: it's what turns drag-and-drop
 * canvas edits into a reviewable, versioned history instead of a silent
 * write — and the bumped version is what "pinned" runs snapshot against.
 */
export async function recordChange(
  graphId: string,
  changeType: RoutingChangeType,
  before: unknown,
  after: unknown,
): Promise<number> {
  const [graph] = await db
    .update(agentGraphs)
    .set({ version: sql`${agentGraphs.version} + 1`, updatedAt: new Date() })
    .where(eq(agentGraphs.id, graphId))
    .returning({ version: agentGraphs.version });

  await db.insert(routingChanges).values({
    graphId,
    changeType,
    before,
    after,
    graphVersion: graph.version,
    changedBy: null, // self-hosted single-user default; wire to auth in Phase 3
  });

  return graph.version;
}
