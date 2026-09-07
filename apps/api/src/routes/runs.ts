import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RunMode } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, runEvents, runs } from "../db/schema.js";
import { loadLiveGraph } from "../orchestrator/engine.js";
import { enqueueHop } from "../queue/runQueue.js";

const createRunBody = z.object({
  graphId: z.string().uuid(),
  input: z.unknown(),
  mode: RunMode.default("pinned"),
});

export async function runRoutes(app: FastifyInstance) {
  app.post("/runs", async (req, reply) => {
    const body = createRunBody.parse(req.body);

    const graphRow = await db.query.agentGraphs.findFirst({
      where: eq(agentGraphs.id, body.graphId),
    });
    if (!graphRow) return reply.code(404).send({ error: "Graph not found" });
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

  app.get("/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(runEvents.sequence);

    return { ...run, events };
  });
}
