import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, runEvents, runs, usageEvents } from "../db/schema.js";
import { loadLiveGraph } from "../orchestrator/engine.js";
import { enqueueHop } from "../queue/runQueue.js";
import { requireAuth } from "../auth/middleware.js";

const createRunBody = z.object({
  graphId: z.string().uuid(),
  input: z.unknown(),
  mode: RunMode.default("pinned"),
});

/**
 * Grok Build's state-sorted triage list (running/blocked first, then
 * everything else by recency) is the pattern this mirrors — see PLAN.md.
 */
const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  pending: 1,
  error: 2,
  completed: 3,
  cancelled: 4,
};

export async function runRoutes(app: FastifyInstance) {
  app.post("/runs", { preHandler: requireAuth }, async (req, reply) => {
    const body = createRunBody.parse(req.body);

    const graphRow = await db.query.agentGraphs.findFirst({
      where: eq(agentGraphs.id, body.graphId),
    });
    if (!graphRow) return reply.code(404).send({ error: "Graph not found" });
    if (graphRow.ownerId !== req.userId) {
      return reply.code(403).send({ error: "You do not own this graph" });
    }
    if (!graphRow.entryNodeId) {
      return reply.code(422).send({ error: "Graph has no entryNodeId set" });
    }

    const graph = await loadLiveGraph(body.graphId);

    const [run] = await db
      .insert(runs)
      .values({
        graphId: body.graphId,
        mode: body.mode,
        graphSnapshot: body.mode === "pinned" ? graph : null,
        status: "pending",
        currentNodeId: graphRow.entryNodeId,
        input: body.input,
      })
      .returning();

    await enqueueHop(run.id);
    return reply.code(201).send(run);
  });

  /**
   * A run's output can contain anything an agent produced — including
   * tool output (e.g. file contents) or the substance of a private
   * conversation. This previously had no auth check at all; found in
   * security review alongside the fileAccessRoot finding it compounds.
   */
  app.get("/runs/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, run.graphId) });
    if (!graph || graph.ownerId !== req.userId) {
      return reply.code(404).send({ error: "Run not found" });
    }

    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(runEvents.sequence);

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, id));
    const usageTotal = usage.reduce(
      (acc, u) => ({
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + u.estimatedCostUsd,
      }),
      { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );

    return { ...run, events, usage, usageTotal };
  });

  /** Companion list view to the hierarchy canvas — see PLAN.md's "Runs list view". */
  app.get("/graphs/:id/runs", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
    if (!graph || graph.ownerId !== req.userId) {
      return reply.code(404).send({ error: "Graph not found" });
    }

    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.graphId, graphId))
      .orderBy(desc(runs.createdAt));

    return rows.sort((a, b) => {
      const priorityDiff = (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99);
      if (priorityDiff !== 0) return priorityDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  });
}
