import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AgentRole, ConsensusGroup, FallbackTarget, ModelTier, ProviderId, RoutingEdgeKind, RoutingCondition, SshTarget } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, routingEdges } from "../db/schema.js";
import { recordChange } from "../db/routingChanges.js";
import { nodeRowToAgentNode } from "./engine.js";
import { checkFileAccessRootAllowed, checkWriteRootAllowed, fileAccessRootSchema } from "../validation/fileAccessRoot.js";
import { checkDispatchTargetsOwned } from "../validation/dispatchTargets.js";
import { checkSshTargetAllowed } from "../validation/sshTarget.js";

/**
 * The node/edge mutation core, shared by the HTTP routes (routes/graphs.ts)
 * and the cross-graph management tools (graphManagementTools.ts) — one
 * code path for "how a node/edge actually gets mutated," not two that
 * could drift (the same principle createRun.ts already follows for
 * manual/scheduled/dispatched runs). Validation (the write-root allowlist,
 * dispatchTargets ownership) lives HERE, not in each caller, so a
 * cross-graph tool call is held to the exact same standard a human editing
 * the node directly through the canvas would be — not a hand-rolled,
 * separately-maintained subset of it.
 */

export const createNodeBody = z.object({
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
  // .nullable() for the same reason as consensusGroup: PATCH needs a way
  // to explicitly clear a previously-set sshTarget, not just leave it
  // unchanged or replace it with a new one.
  sshTarget: SshTarget.nullable().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
});

export const updateNodeBody = createNodeBody.partial();

export const createEdgeBody = z.object({
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  kind: RoutingEdgeKind.default("explicit"),
  condition: RoutingCondition.optional(),
  priority: z.number().int().optional(),
});

export type CreateNodeBody = z.infer<typeof createNodeBody>;
export type UpdateNodeBody = z.infer<typeof updateNodeBody>;
export type CreateEdgeBody = z.infer<typeof createEdgeBody>;

export type MutationResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Shared by the manual "+ Add agent" form, natural-language quick-add, and now cross-graph node creation — one insert path, one place to keep in sync with the schema. */
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
      sshTarget: body.sshTarget ?? null,
      positionX: body.position.x,
      positionY: body.position.y,
    })
    .returning();
  await recordChange(graphId, "node_added", null, node);
  return nodeRowToAgentNode(node);
}

/**
 * Validated create, for callers (the cross-graph management tools) that
 * don't already have an HTTP request body to run createNodeBody.parse()
 * against but still need the exact same allowlist/ownership checks the
 * manual node route enforces.
 */
export async function insertAgentNodeValidated(
  graphId: string,
  body: CreateNodeBody,
  userId: string | null,
): Promise<MutationResult<ReturnType<typeof nodeRowToAgentNode>>> {
  // Read allowlist first: the HTTP route gets this for free from
  // createNodeBody.parse()'s fileAccessRootSchema refine, but a caller
  // that builds a plain object directly (the cross-graph management
  // tools) never runs that parse — this check must not depend on it.
  const accessError = checkFileAccessRootAllowed(body.fileAccessRoot);
  if (accessError) return { ok: false, status: 400, error: accessError };
  const writeError = checkWriteRootAllowed(body.tools, body.fileAccessRoot);
  if (writeError) return { ok: false, status: 400, error: writeError };
  const dispatchError = await checkDispatchTargetsOwned(body.tools, body.dispatchTargets, userId);
  if (dispatchError) return { ok: false, status: 400, error: dispatchError };
  const sshError = checkSshTargetAllowed(body.sshTarget);
  if (sshError) return { ok: false, status: 400, error: sshError };
  return { ok: true, value: await insertAgentNode(graphId, body) };
}

export async function updateAgentNode(
  graphId: string,
  nodeId: string,
  body: UpdateNodeBody,
  userId: string | null,
): Promise<MutationResult<ReturnType<typeof nodeRowToAgentNode>>> {
  // graphId scoped in the lookup, not just an ownership check the caller
  // may have already done — otherwise a caller's own graph id paired with
  // another graph's node id would still pass. Found in security review
  // (IDOR/BOLA) for the HTTP route; holds here for every caller too.
  const before = await db.query.agentNodes.findFirst({
    where: and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)),
  });
  if (!before) return { ok: false, status: 404, error: "Node not found" };

  // A partial update — "tools" or "fileAccessRoot" may not appear in THIS
  // call at all if only the other one is being changed, so both checks
  // must run against the EFFECTIVE (post-merge) values.
  const effectiveTools = body.tools ?? (before.tools as string[] | undefined);
  const effectiveFileAccessRoot = body.fileAccessRoot !== undefined ? body.fileAccessRoot : before.fileAccessRoot;
  const accessError = checkFileAccessRootAllowed(effectiveFileAccessRoot);
  if (accessError) return { ok: false, status: 400, error: accessError };
  const writeError = checkWriteRootAllowed(effectiveTools, effectiveFileAccessRoot);
  if (writeError) return { ok: false, status: 400, error: writeError };

  const effectiveDispatchTargets =
    body.dispatchTargets !== undefined ? body.dispatchTargets : (before.dispatchTargets as string[] | null | undefined);
  const dispatchError = await checkDispatchTargetsOwned(effectiveTools, effectiveDispatchTargets, userId);
  if (dispatchError) return { ok: false, status: 400, error: dispatchError };

  const effectiveSshTarget =
    body.sshTarget !== undefined ? body.sshTarget : (before.sshTarget as SshTarget | null | undefined);
  const sshError = checkSshTargetAllowed(effectiveSshTarget);
  if (sshError) return { ok: false, status: 400, error: sshError };

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
  return { ok: true, value: nodeRowToAgentNode(after) };
}

export async function deleteAgentNode(graphId: string, nodeId: string): Promise<MutationResult<null>> {
  const before = await db.query.agentNodes.findFirst({
    where: and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)),
  });
  if (!before) return { ok: false, status: 404, error: "Node not found" };

  // routingEdges.sourceNodeId/targetNodeId cascade on delete, but
  // agentGraphs.entryNodeId is not a real FK — clear it explicitly so a
  // deleted node never leaves the graph pointing at a dangling entry node.
  await db
    .update(agentGraphs)
    .set({ entryNodeId: null })
    .where(and(eq(agentGraphs.id, graphId), eq(agentGraphs.entryNodeId, nodeId)));

  await db.delete(agentNodes).where(and(eq(agentNodes.id, nodeId), eq(agentNodes.graphId, graphId)));
  await recordChange(graphId, "node_removed", before, null);
  return { ok: true, value: null };
}

export async function insertRoutingEdge(graphId: string, body: CreateEdgeBody) {
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
  // remembered to PATCH consensusGroup by hand. Auto-sync on create; still
  // overridable by PATCHing a specific edge back out afterward.
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

  return edge;
}

export async function deleteRoutingEdge(graphId: string, edgeId: string): Promise<MutationResult<null>> {
  const before = await db.query.routingEdges.findFirst({
    where: and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)),
  });
  if (!before) return { ok: false, status: 404, error: "Edge not found" };

  await db.delete(routingEdges).where(and(eq(routingEdges.id, edgeId), eq(routingEdges.graphId, graphId)));
  await recordChange(before.graphId, "edge_removed", before, null);
  return { ok: true, value: null };
}
