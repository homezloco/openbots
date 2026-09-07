import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AgentRole, ProviderId, RoutingEdgeKind, RoutingCondition } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, routingEdges } from "../db/schema.js";
import { recordChange } from "../db/routingChanges.js";
import { loadLiveGraph } from "../orchestrator/engine.js";

const createGraphBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const createNodeBody = z.object({
  name: z.string().min(1),
  role: AgentRole,
  provider: ProviderId,
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  description: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
});

const createEdgeBody = z.object({
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  kind: RoutingEdgeKind.default("explicit"),
  condition: RoutingCondition.optional(),
  priority: z.number().int().optional(),
});

const rerouteEdgeBody = z.object({
  targetNodeId: z.string().uuid(),
});

const updateGraphBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  entryNodeId: z.string().uuid().optional(),
});

export async function graphRoutes(app: FastifyInstance) {
  app.post("/graphs", async (req, reply) => {
    const body = createGraphBody.parse(req.body);
    const [graph] = await db
      .insert(agentGraphs)
      .values({ name: body.name, description: body.description ?? "" })
      .returning();
    return reply.code(201).send(graph);
  });

  app.get("/graphs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return loadLiveGraph(id);
  });

  app.patch("/graphs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateGraphBody.parse(req.body);
    const [graph] = await db
      .update(agentGraphs)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(agentGraphs.id, id))
      .returning();
    if (!graph) return reply.code(404).send({ error: "Graph not found" });
    return graph;
  });

  app.post("/graphs/:id/nodes", async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    const body = createNodeBody.parse(req.body);
    const [node] = await db
      .insert(agentNodes)
      .values({
        graphId,
        name: body.name,
        role: body.role,
        provider: body.provider,
        model: body.model,
        systemPrompt: body.systemPrompt ?? "",
        description: body.description ?? "",
        positionX: body.position.x,
        positionY: body.position.y,
      })
      .returning();
    await recordChange(graphId, "node_added", null, node);
    return reply.code(201).send(node);
  });

  app.post("/graphs/:id/edges", async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    const body = createEdgeBody.parse(req.body);
    const [edge] = await db
      .insert(routingEdges)
      .values({
        graphId,
        sourceNodeId: body.sourceNodeId,
        targetNodeId: body.targetNodeId,
        kind: body.kind,
        condition: body.condition ?? "default",
        priority: body.priority ?? 0,
      })
      .returning();
    await recordChange(graphId, "edge_added", null, edge);
    return reply.code(201).send(edge);
  });

  /**
   * The drag-and-drop rerouting endpoint: dropping an edge onto a new
   * target node calls this. It never touches a running orchestration
   * loop directly — it just updates the row that resolveNextHop() will
   * read on the affected run's next hop (see orchestrator/resolve.ts).
   */
  app.patch("/graphs/:id/edges/:edgeId", async (req, reply) => {
    const { edgeId } = req.params as { id: string; edgeId: string };
    const body = rerouteEdgeBody.parse(req.body);

    const before = await db.query.routingEdges.findFirst({ where: eq(routingEdges.id, edgeId) });
    if (!before) return reply.code(404).send({ error: "Edge not found" });

    const [after] = await db
      .update(routingEdges)
      .set({ targetNodeId: body.targetNodeId, updatedAt: new Date() })
      .where(eq(routingEdges.id, edgeId))
      .returning();

    await recordChange(before.graphId, "edge_rerouted", before, after);
    return after;
  });

  app.delete("/graphs/:id/edges/:edgeId", async (req, reply) => {
    const { edgeId } = req.params as { id: string; edgeId: string };
    const before = await db.query.routingEdges.findFirst({ where: eq(routingEdges.id, edgeId) });
    if (!before) return reply.code(404).send({ error: "Edge not found" });

    await db.delete(routingEdges).where(eq(routingEdges.id, edgeId));
    await recordChange(before.graphId, "edge_removed", before, null);
    return reply.code(204).send();
  });
}
