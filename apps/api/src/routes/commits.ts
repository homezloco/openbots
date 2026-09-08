import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentCommits, agentNodes } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";

/**
 * Surfaces agentCommits (populated by engine.ts::callAgent alongside the
 * commit-note it already appends to a hop's output) so the UI can show
 * "there are N unpushed commits" instead of the user having to remember
 * to type /push. agentCommits.nodeId has no FK (same reasoning as
 * run_events.nodeId — a node can move between graphs or be deleted, but
 * its commit history should stay visible), so the node name is a
 * best-effort left join, not a guaranteed one.
 */
export async function commitRoutes(app: FastifyInstance) {
  app.get("/graphs/:graphId/commits", { preHandler: requireAuth }, async (req, reply) => {
    const { graphId } = req.params as { graphId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    const rows = await db
      .select({
        id: agentCommits.id,
        runId: agentCommits.runId,
        nodeId: agentCommits.nodeId,
        nodeName: agentNodes.name,
        branch: agentCommits.branch,
        commitSha: agentCommits.commitSha,
        pushedAt: agentCommits.pushedAt,
        createdAt: agentCommits.createdAt,
      })
      .from(agentCommits)
      .leftJoin(agentNodes, eq(agentCommits.nodeId, agentNodes.id))
      .where(eq(agentCommits.graphId, graphId))
      .orderBy(desc(agentCommits.createdAt));

    return rows.map((r) => ({
      ...r,
      nodeName: r.nodeName ?? "Unknown agent",
      pushedAt: r.pushedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
