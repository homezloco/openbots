import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { FallbackTarget } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, runs, scheduledTriggers } from "../db/schema.js";
import { loadLiveGraph } from "../orchestrator/engine.js";
import { requireAuth } from "../auth/middleware.js";
import { unregisterSchedule } from "../queue/scheduleQueue.js";
import {
  createEdgeBody,
  createNodeBody,
  deleteAgentNode,
  deleteRoutingEdge,
  insertAgentNodeValidated,
  insertRoutingEdge,
  updateAgentNode,
  updateEdgeBody,
  updateNodeBody,
  updateRoutingEdge,
} from "../orchestrator/graphMutations.js";
import { createAgencyExample, createLiveRerouteExample } from "../orchestrator/exampleGraphs.js";

const createGraphBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const fromExistingNodeBody = z.object({
  sourceNodeId: z.string().uuid(),
  position: z.object({ x: z.number(), y: z.number() }),
});

const updateGraphBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  entryNodeId: z.string().uuid().optional(),
  /**
   * Graph-wide default fallback chain — a node with its own (non-empty)
   * fallbackChain ignores this; only a node with an empty chain uses it.
   * See AgentGraph.fallbackChain and engine.ts::callAgent.
   */
  fallbackChain: z.array(FallbackTarget).optional(),
});

/** Every graph gets an owner at creation; per-graph reads and mutations require the caller to match. */
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
   * The README GIF as a real graph: Router → Support, with Billing as the
   * drop target. Static path (not /graphs/:id/...) so Fastify doesn't try
   * to parse "examples" as a uuid.
   */
  app.post("/graphs/examples/live-reroute", { preHandler: requireAuth }, async (req, reply) => {
    const graph = await createLiveRerouteExample(req.userId!);
    return reply.code(201).send(graph);
  });

  /**
   * Nested org demo: Acme Portfolio (one Lead that dispatches) plus two
   * team graphs. Returns the portfolio graph so the client can open it;
   * gateways on that canvas are derived from dispatchTargets.
   */
  app.post("/graphs/examples/agency", { preHandler: requireAuth }, async (req, reply) => {
    const graph = await createAgencyExample(req.userId!);
    return reply.code(201).send(graph);
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

  app.get("/graphs/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, id))) return;
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
    const result = await insertAgentNodeValidated(graphId, body, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
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
    // dispatchTargets, sshTarget, and mcpServers are deliberately dropped
    // too — even though the referenced graph ids/host/URL stay technically
    // valid across the copy, "may fire runs into these other graphs",
    // "may run commands on this host", or "may call this MCP server with
    // the account token" is significant enough capability that copying a
    // node into a new context should require re-granting it explicitly,
    // not carrying it over silently.
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
    const result = await insertAgentNodeValidated(graphId, copied, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
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
    const result = await updateAgentNode(graphId, nodeId, body, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.delete("/graphs/:id/nodes/:nodeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, nodeId } = req.params as { id: string; nodeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const result = await deleteAgentNode(graphId, nodeId, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(204).send();
  });

  app.post("/graphs/:id/edges", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId } = req.params as { id: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = createEdgeBody.parse(req.body);
    const result = await insertRoutingEdge(graphId, body, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
  });

  /**
   * The drag-and-drop rerouting endpoint: dropping an edge onto a new
   * target node calls this. It never touches a running orchestration
   * loop directly — it just updates the row that resolveNextHop() will
   * read on the affected run's next hop (see orchestrator/resolve.ts).
   * Every field is optional, so this doubles as the endpoint for editing
   * an explicit edge's condition/priority/label without retargeting it.
   */
  app.patch("/graphs/:id/edges/:edgeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, edgeId } = req.params as { id: string; edgeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const body = updateEdgeBody.parse(req.body);
    const result = await updateRoutingEdge(graphId, edgeId, body, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.delete("/graphs/:id/edges/:edgeId", { preHandler: requireAuth }, async (req, reply) => {
    const { id: graphId, edgeId } = req.params as { id: string; edgeId: string };
    if (!(await requireGraphOwner(req, reply, graphId))) return;
    const result = await deleteRoutingEdge(graphId, edgeId, req.userId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(204).send();
  });
}

export { requireGraphOwner };
