import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AgentRole,
  ConsensusGroup,
  FallbackTarget,
  ModelTier,
  ProviderId,
  RoutingEdgeKind,
  RoutingCondition,
} from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, routingEdges, runs, scheduledTriggers } from "../db/schema.js";
import { recordChange } from "../db/routingChanges.js";
import { loadLiveGraph, nodeRowToAgentNode } from "../orchestrator/engine.js";
import { requireAuth } from "../auth/middleware.js";
import { checkWriteRootAllowed, fileAccessRootSchema } from "../validation/fileAccessRoot.js";
import { checkDispatchTargetsOwned } from "../validation/dispatchTargets.js";
import { unregisterSchedule } from "../queue/scheduleQueue.js";

const createGraphBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const createNodeBody = z.object({
  name: z.string().min(1),
  role: AgentRole,
  provider: ProviderId,
  model: z.string().min(1),
  tier: ModelTier.optional(),
  systemPrompt: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  fileAccessRoot: fileAccessRootSchema.optional(),
  fallbackChain: z.array(FallbackTarget).optional(),
  // .nullable() in addition to .optional(): PATCH needs a way to explicitly
  // CLEAR an existing consensusGroup (e.g. converting a hybrid node back to
  // plain auto routing), not just leave it unchanged (omitted) or replace
  // it with a new one. Harmless on create, where null and omitted already
  // behave identically.
  consensusGroup: ConsensusGroup.nullable().optional(),
  dispatchTargets: z.array(z.string().uuid()).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
});

const updateNodeBody = createNodeBody.partial();

const fromExistingNodeBody = z.object({
  sourceNodeId: z.string().uuid(),
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

/** Every graph gets an owner at creation; mutations require the caller to match. Reads stay public. */
async function requireGraphOwner(
  req: FastifyRequest,
  reply: FastifyReply,
  graphId: string,
): Promise<boolean> {
  const graph = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
  if (!graph) {
    reply.code(404).send({ error: "Graph not found" });
    return false;
  }
  if (graph.ownerId !== req.userId) {
    reply.code(403).send({ error: "You do not own this graph" });
    return false;
  }
  return true;
}

export type CreateNodeBody = z.infer<typeof createNodeBody>;

/** Shared by the manual "+ Add agent" form and the natural-language quick-add route — one insert path, one place to keep in sync with the schema. */
export async function insertAgentNode(graphId: string, body: CreateNodeBody) {
  const [node] = await db
    .insert(agentNodes)
    .values({
      graphId,
      name: body.name,
      role: body.role,
      provider: body.provider,
      model: body.model,
      tier: body.tier ?? null,
      systemPrompt: body.systemPrompt ?? "",
      description: body.description ?? "",
      tools: body.tools ?? [],
      fileAccessRoot: body.fileAccessRoot ?? null,
      fallbackChain: body.fallbackChain ?? [],
      consensusGroup: body.consensusGroup ?? null,
      dispatchTargets: body.dispatchTargets ?? null,
      positionX: body.position.x,
      positionY: body.position.y,
    })
    .returning();
  await recordChange(graphId, "node_added", null, node);
  return nodeRowToAgentNode(node);
}

export async function graphRoutes(app: FastifyInstance) {
  app.post("/graphs", { preHandler: requireAuth }, async (req, reply) => {
    const body = createGraphBody.parse(req.body);
    const [graph] = await db
      .insert(agentGraphs)
      .values({ name: body.name, description: body.description ?? "", ownerId: req.userId })
      .returning();
    // Loaded rather than returning the raw row: AgentGraph requires
    // nodes/edges/warnings, which a bare insert `.returning()` row doesn't
    // have — the same shape mismatch that crashed the canvas on node
    // creation (see nodeRowToAgentNode). A brand-new graph has none of
    // either yet, so this is two cheap empty-result queries.
    return reply.code(201).send(await loadLiveGraph(graph.id));
  });

  /**
   * The "roster" endpoint: every graph you own, with a node count so the
   * Dashboard can decide whether to show a single-node graph as a chat
   * "bot" or link a multi-node graph straight to Hierarchy.
   */
  app.get("/graphs", { preHandler: requireAuth }, async (req) => {
    const graphs = await db
      .select()
      .from(agentGraphs)
      .where(eq(agentGraphs.ownerId, req.userId!))
      .orderBy(desc(agentGraphs.updatedAt));

    const counts = await db
      .select({ graphId: agentNodes.graphId, count: sql<number>`count(*)::int` })
      .from(agentNodes)
      .groupBy(agentNodes.graphId);
    const countByGraph = new Map(counts.map((c) => [c.graphId, c.count]));

    // graph.updatedAt reflects the last STRUCTURAL edit (a node/edge
    // change), not the last conversation — the Dashboard needs the latter
    // to auto-select "the graph you were most recently chatting with".
    const lastRuns = await db
      .select({ graphId: runs.graphId, lastRunAt: sql<string>`max(${runs.createdAt})` })
      .from(runs)
      .groupBy(runs.graphId);
    const lastRunByGraph = new Map(lastRuns.map((r) => [r.graphId, r.lastRunAt]));

    return graphs.map((g) => ({
      ...g,
      nodeCount: countByGraph.get(g.id) ?? 0,
      lastRunAt: lastRunByGraph.get(g.id) ?? null,
    }));
  });

  app.get("/graphs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return loadLiveGraph(id);
  });

  /**
   * Cascades to the graph's nodes/edges/runs/routing-changes/credentials/
   * scheduled-triggers via FK onDelete rules in db/schema.ts. The DB rows
   * cascade automatically, but a scheduled trigger's BullMQ job scheduler
   * lives in Redis, entirely independent of Postgres's FK graph — without
   * this it would silently keep firing forever, hitting the worker's
   * "trigger not found in DB → skip" no-op path but never actually
   * cleaning itself up.
   */
  app.delete("/graphs/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, id))) return;
    const schedules = await db.select({ id: scheduledTriggers.id }).from(scheduledTriggers).where(eq(scheduledTriggers.graphId, id));
    await db.delete(agentGraphs).where(eq(agentGraphs.id, id));
    await Promise.all(schedules.map((s) => unregisterSchedule(s.id)));
    return reply.code(204).send();
  });

  app.patch("/graphs/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, id))) return;
    const body = updateGraphBody.parse(req.body);
    await db
      .update(agentGraphs)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(agentGraphs.id, id));
    // See the comment in POST /graphs: return the fully-shaped AgentGraph, not the raw update row.
    return loadLiveGraph(id);
  });

  app.post("/graphs/:id/nodes", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = createNodeBody.parse(req.body);
    const writeError = checkWriteRootAllowed(body.tools, body.fileAccessRoot);
    if (writeError) return reply.code(400).send({ error: writeError });
    const dispatchError = await checkDispatchTargetsOwned(body.tools, body.dispatchTargets, req.userId);
    if (dispatchError) return reply.code(400).send({ error: dispatchError });
    const node = await insertAgentNode(graphId, body);
    return reply.code(201).send(node);
  });

  /**
   * Copies an already-configured agent from ANY graph the caller owns into
   * this one — the "add existing agent" flow, distinct from templates
   * (which only reuse a whole graph). Two independent ownership checks are
   * required, not the usual single and(eq(id), eq(graphId)): this spans
   * TWO graphs (the target `:id` and the source node's own graphId), so
   * proving you own one says nothing about the other.
   */
  app.post("/graphs/:id/nodes/from-existing", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = fromExistingNodeBody.parse(req.body);

    const source = await db.query.agentNodes.findFirst({ where: eq(agentNodes.id, body.sourceNodeId) });
    if (!source) return reply.code(404).send({ error: "Source agent not found" });
    if (!(await requireGraphOwner(req, reply, source.graphId))) return;

    // Re-run the exact same validation (including the fileAccessRoot
    // allowlist) any other node-creation path goes through, rather than
    // trusting that the source row is still valid under today's allowlist.
    // consensusGroup is deliberately dropped: it references edge ids
    // scoped to the source graph and would be dangling in this one.
    // dispatchTargets is deliberately dropped too — even though the
    // referenced graph ids stay technically valid across the copy, "may
    // fire runs into these other graphs" is significant enough capability
    // that copying a node into a new context should require re-granting
    // it explicitly, not carrying it over silently.
    const copied = createNodeBody.parse({
      name: source.name,
      role: source.role,
      provider: source.provider,
      model: source.model,
      tier: source.tier ?? undefined,
      systemPrompt: source.systemPrompt,
      description: source.description,
      tools: source.tools,
      fileAccessRoot: source.fileAccessRoot ?? undefined,
      fallbackChain: source.fallbackChain,
      position: body.position,
    });
    const writeError = checkWriteRootAllowed(copied.tools, copied.fileAccessRoot);
    if (writeError) return reply.code(400).send({ error: writeError });
    const node = await insertAgentNode(graphId, copied);
    return reply.code(201).send(node);
  });

  /**
   * Exists mainly so `consensusGroup` can be set at all: it references edge
   * ids, which don't exist until after the node and its edges are created,
   * so it can never be supplied at node-creation time for a real consensus
   * setup. Also doubles as the general node-edit endpoint.
   */
  app.patch("/graphs/:id/nodes/:nodeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, nodeId } = req.params as { id: string; nodeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = updateNodeBody.parse(req.body);

    // graphId is included in both lookups below, not just the ownership
    // check above — otherwise a caller could pass their OWN graphId with
    // ANOTHER user's nodeId and still pass requireGraphOwner, then edit a
    // node that isn't theirs. Found in security review (IDOR/BOLA).
    const before = await db.query.agentNodes.findFirst({
      where: and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)),
    });
    if (!before) return reply.code(404).send({ error: "Node not found" });

    // A PATCH is a partial update — "tools" or "fileAccessRoot" may not
    // appear in THIS request body at all if only the other one is being
    // changed, so the write-root check must run against the EFFECTIVE
    // (post-merge) values, not just whatever this one request happened
    // to include.
    const effectiveTools = body.tools ?? (before.tools as string[] | undefined);
    const effectiveFileAccessRoot = body.fileAccessRoot !== undefined ? body.fileAccessRoot : before.fileAccessRoot;
    const writeError = checkWriteRootAllowed(effectiveTools, effectiveFileAccessRoot);
    if (writeError) return reply.code(400).send({ error: writeError });

    const effectiveDispatchTargets =
      body.dispatchTargets !== undefined ? body.dispatchTargets : (before.dispatchTargets as string[] | null | undefined);
    const dispatchError = await checkDispatchTargetsOwned(effectiveTools, effectiveDispatchTargets, req.userId);
    if (dispatchError) return reply.code(400).send({ error: dispatchError });

    const { position, ...rest } = body;
    const [after] = await db
      .update(agentNodes)
      .set({
        ...rest,
        ...(position ? { positionX: position.x, positionY: position.y } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)))
      .returning();

    await recordChange(graphId, "node_updated", before, after);
    return nodeRowToAgentNode(after);
  });

  app.delete("/graphs/:id/nodes/:nodeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, nodeId } = req.params as { id: string; nodeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;

    // graphId scoped here too — same IDOR class as the node PATCH above.
    const before = await db.query.agentNodes.findFirst({
      where: and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)),
    });
    if (!before) return reply.code(404).send({ error: "Node not found" });

    // routingEdges.sourceNodeId/targetNodeId cascade on delete, but
    // agentGraphs.entryNodeId is not a real FK (it references either an
    // agent_nodes row or nothing yet) — clear it explicitly so a deleted
    // node never leaves the graph pointing at a dangling entry node.
    await db
      .update(agentGraphs)
      .set({ entryNodeId: null })
      .where(and(eq(agentGraphs.id, graphId), eq(agentGraphs.entryNodeId, nodeId)));

    await db.delete(agentNodes).where(and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)));
    await recordChange(graphId, "node_removed", before, null);
    return reply.code(204).send();
  });

  app.post("/graphs/:id/edges", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
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

    // A hybrid node's ALL fan-out (see engine.ts) is a fixed edgeIds list,
    // not derived live from the graph — without this, adding a new
    // auto-routed specialist under an existing hybrid supervisor would
    // silently miss it in every future ALL broadcast until someone
    // remembered to PATCH consensusGroup by hand. Auto-sync on create;
    // still overridable by PATCHing a specific edge back out afterward.
    if (edge.kind === "auto") {
      const sourceNode = await db.query.agentNodes.findFirst({ where: eq(agentNodes.id, edge.sourceNodeId) });
      if (sourceNode?.consensusGroup) {
        const group = sourceNode.consensusGroup as { edgeIds: string[]; aggregatorNodeId: string };
        await db
          .update(agentNodes)
          .set({ consensusGroup: { ...group, edgeIds: [...group.edgeIds, edge.id] }, updatedAt: new Date() })
          .where(eq(agentNodes.id, sourceNode.id));
      }
    }

    return reply.code(201).send(edge);
  });

  /**
   * The drag-and-drop rerouting endpoint: dropping an edge onto a new
   * target node calls this. It never touches a running orchestration
   * loop directly — it just updates the row that resolveNextHop() will
   * read on the affected run's next hop (see orchestrator/resolve.ts).
   */
  app.patch("/graphs/:id/edges/:edgeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, edgeId } = req.params as { id: string; edgeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = rerouteEdgeBody.parse(req.body);

    // graphId scoped here too — same IDOR class as the node PATCH above.
    const before = await db.query.routingEdges.findFirst({
      where: and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)),
    });
    if (!before) return reply.code(404).send({ error: "Edge not found" });

    const [after] = await db
      .update(routingEdges)
      .set({ targetNodeId: body.targetNodeId, updatedAt: new Date() })
      .where(and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)))
      .returning();

    await recordChange(before.graphId, "edge_rerouted", before, after);
    return after;
  });

  app.delete("/graphs/:id/edges/:edgeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, edgeId } = req.params as { id: string; edgeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const before = await db.query.routingEdges.findFirst({
      where: and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)),
    });
    if (!before) return reply.code(404).send({ error: "Edge not found" });

    await db.delete(routingEdges).where(and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)));
    await recordChange(before.graphId, "edge_removed", before, null);
    return reply.code(204).send();
  });
}

export { requireGraphOwner };
