import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentGraph } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, agentTemplates, routingEdges } from "../db/schema.js";
import { loadLiveGraph } from "../orchestrator/engine.js";
import { requireAuth } from "../auth/middleware.js";
import { requireGraphOwner } from "./graphs.js";

const createTemplateBody = z.object({
  graphId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
});

/**
 * A template is a self-contained snapshot (nodes/edges embedded as JSON),
 * not a live reference to the source graph — editing the source afterward
 * never changes the template. See AgentTemplate in @openbots/graph-schema.
 */
export async function templateRoutes(app: FastifyInstance) {
  app.post("/templates", { preHandler: requireAuth }, async (req, reply) => {
    const body = createTemplateBody.parse(req.body);
    if (!(await requireGraphOwner(req, reply, body.graphId))) return;

    const graph = await loadLiveGraph(body.graphId);
    const [template] = await db
      .insert(agentTemplates)
      .values({
        name: body.name,
        description: body.description ?? "",
        graph,
        authorId: req.userId,
      })
      .returning();

    return reply.code(201).send({ ...template, createdAt: template.createdAt.toISOString() });
  });

  app.get("/templates", { preHandler: requireAuth }, async (req) => {
    const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.authorId, req.userId!));
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      authorId: t.authorId,
      createdAt: t.createdAt.toISOString(),
      nodeCount: (t.graph as AgentGraph).nodes.length,
    }));
  });

  /** Deep-copies the template's graph into a brand-new, owned graph with fresh node/edge ids. */
  app.post("/templates/:id/instantiate", { preHandler: requireAuth }, async (req, reply) => {
    const { id: templateId } = req.params as { id: string };
    const template = await db.query.agentTemplates.findFirst({ where: eq(agentTemplates.id, templateId) });
    if (!template) return reply.code(404).send({ error: "Template not found" });
    if (template.authorId !== req.userId) return reply.code(403).send({ error: "You did not create this template" });

    const graph = template.graph as AgentGraph;

    const [newGraph] = await db
      .insert(agentGraphs)
      .values({ name: graph.name, description: graph.description, ownerId: req.userId })
      .returning();

    const nodeIdMap = new Map<string, string>();
    const insertedNodes: { old: AgentGraph["nodes"][number]; newId: string }[] = [];
    for (const node of graph.nodes) {
      // fileAccessRoot, dispatchTargets, sshTarget, and mcpServers are
      // deliberately NOT copied here (all absent from this values object)
      // — a template's source paths/graph ids/MCP URLs are meaningless or
      // too powerful in a new context. tools is copied verbatim, so an
      // instantiated write-, dispatch-, or mcp-capable node needs a
      // follow-up PATCH before it's actually usable.
      const [inserted] = await db
        .insert(agentNodes)
        .values({
          graphId: newGraph.id,
          name: node.name,
          role: node.role,
          provider: node.provider,
          model: node.model,
          tier: node.tier ?? null,
          systemPrompt: node.systemPrompt,
          description: node.description,
          tools: node.tools,
          fallbackChain: node.fallbackChain,
          positionX: node.position.x,
          positionY: node.position.y,
        })
        .returning();
      nodeIdMap.set(node.id, inserted.id);
      insertedNodes.push({ old: node, newId: inserted.id });
    }

    const edgeIdMap = new Map<string, string>();
    for (const edge of graph.edges) {
      const [inserted] = await db
        .insert(routingEdges)
        .values({
          graphId: newGraph.id,
          sourceNodeId: nodeIdMap.get(edge.sourceNodeId)!,
          targetNodeId: nodeIdMap.get(edge.targetNodeId)!,
          kind: edge.kind,
          condition: edge.condition,
          priority: edge.priority,
          label: edge.label,
        })
        .returning();
      edgeIdMap.set(edge.id, inserted.id);
    }

    // consensusGroup references node/edge ids that only exist after both maps above are complete.
    for (const { old, newId } of insertedNodes) {
      if (old.consensusGroup) {
        await db
          .update(agentNodes)
          .set({
            consensusGroup: {
              edgeIds: old.consensusGroup.edgeIds.map((eid) => edgeIdMap.get(eid)!),
              aggregatorNodeId: nodeIdMap.get(old.consensusGroup.aggregatorNodeId)!,
            },
          })
          .where(eq(agentNodes.id, newId));
      }
    }

    if (graph.entryNodeId) {
      await db
        .update(agentGraphs)
        .set({ entryNodeId: nodeIdMap.get(graph.entryNodeId) ?? null })
        .where(eq(agentGraphs.id, newGraph.id));
    }

    return reply.code(201).send(await loadLiveGraph(newGraph.id));
  });
}
