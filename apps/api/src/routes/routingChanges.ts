import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { routingChanges } from "../db/schema.js";

/** The versioned audit trail every graph mutation writes to (see db/routingChanges.ts) — read-only here. */
export async function routingChangeRoutes(app: FastifyInstance) {
  app.get("/graphs/:id/routing-changes", async (req) => {
    const { id: graphId } = req.params as { id: string };
    return db
      .select()
      .from(routingChanges)
      .where(eq(routingChanges.graphId, graphId))
      .orderBy(asc(routingChanges.graphVersion));
  });
}
