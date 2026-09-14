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
  changedBy?: string | null,
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
    // The mutating user's id where the caller has one (HTTP routes and
    // cross-graph tools always do); null for system-seeded changes like
    // example graphs — still nullable for any future non-user actor.
    changedBy: changedBy ?? null,
  });

  return graph.version;
}
