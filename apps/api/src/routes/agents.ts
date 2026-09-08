import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes } from "../db/schema.js";
import { nodeRowToAgentNode } from "../orchestrator/engine.js";
import { requireAuth } from "../auth/middleware.js";

/**
 * Cross-graph node listing for the "add existing agent" flow — the only
 * other reuse mechanism (templates) works at whole-graph granularity only.
 * Not nested under /graphs/:id since it spans every graph the caller owns.
 */
export async function agentRoutes(app: FastifyInstance) {
  app.get("/agents", { preHandler: requireAuth }, async (req) => {
    const rows = await db
      .select({ node: agentNodes, graphName: agentGraphs.name })
      .from(agentNodes)
      .innerJoin(agentGraphs, eq(agentNodes.graphId, agentGraphs.id))
      .where(eq(agentGraphs.ownerId, req.userId!));

    return rows.map((r) => ({ ...nodeRowToAgentNode(r.node), graphName: r.graphName }));
  });
}
