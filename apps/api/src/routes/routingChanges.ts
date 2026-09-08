import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { routingChanges } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";

/**
 * The versioned audit trail every graph mutation writes to (see
 * db/routingChanges.ts) — read-only here. before/after can contain a
 * node's full config (system prompt, fileAccessRoot, tools) — this was
 * found with NO auth check at all during a documentation completeness
 * pass, the same bug class (see PLAN.md's security reviews) that hit
 * GET /runs/:id and GET /graphs/:id/runs before those were locked down.
 */
export async function routingChangeRoutes(app: FastifyInstance) {
  app.get("/graphs/:id/routing-changes", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    return db
      .select()
      .from(routingChanges)
      .where(eq(routingChanges.graphId, graphId))
      .orderBy(asc(routingChanges.graphVersion));
  });
}
