import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentNodes, routingEdges } from "../db/schema.js";

interface EffectiveNodeConfig {
  approvalConfig?: unknown;
  mapConfig?: { targetNodeId?: string } | null;
  consensusGroup?: { edgeIds?: string[] } | null;
}

/**
 * A gated node cannot be a map or consensus branch TARGET: both fan-out
 * mechanisms (engine.ts's dispatchMap/dispatchConsensus) run every branch
 * inline inside one BullMQ job via Promise.allSettled — there is no queue
 * boundary to pause a branch at, so a gate on a fan-out target would
 * either be silently ignored or hold the whole job open. Rejected at save
 * time rather than discovered at runtime.
 *
 * Checked from BOTH directions, since either save order must be rejected
 * the same way: gating a node that is ALREADY a fan-out target (direction
 * 1), and pointing a NEW fan-out target at an already-gated node
 * (directions 2/3). The aggregator itself is exempt — it is dispatched
 * through the queue normally, via advanceRun.
 *
 * `nodeId` is null for a not-yet-created node (insertAgentNodeValidated) —
 * direction 1 is skipped there, since a node that doesn't exist yet can't
 * already be referenced as someone else's target.
 */
export async function checkApprovalGateCompatible(
  graphId: string,
  nodeId: string | null,
  effective: EffectiveNodeConfig,
): Promise<string | null> {
  const wantsGate = Boolean(effective.approvalConfig);
  const mapTargetId = effective.mapConfig?.targetNodeId;
  const consensusEdgeIds = effective.consensusGroup?.edgeIds ?? [];
  if (!wantsGate && !mapTargetId && consensusEdgeIds.length === 0) return null;

  const [nodes, edges] = await Promise.all([
    db
      .select({
        id: agentNodes.id,
        name: agentNodes.name,
        approvalConfig: agentNodes.approvalConfig,
        mapConfig: agentNodes.mapConfig,
        consensusGroup: agentNodes.consensusGroup,
      })
      .from(agentNodes)
      .where(eq(agentNodes.graphId, graphId)),
    db
      .select({ id: routingEdges.id, targetNodeId: routingEdges.targetNodeId })
      .from(routingEdges)
      .where(eq(routingEdges.graphId, graphId)),
  ]);
  const edgeTarget = new Map(edges.map((e) => [e.id, e.targetNodeId]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  if (wantsGate && nodeId) {
    for (const n of nodes) {
      if (n.id === nodeId) continue;
      const map = n.mapConfig as { targetNodeId?: string } | null;
      if (map?.targetNodeId === nodeId) {
        return `Cannot add an approval gate: this node is the map target of "${n.name}". Map and consensus branches run inline with no queue boundary to pause at.`;
      }
      const group = n.consensusGroup as { edgeIds?: string[] } | null;
      if (group?.edgeIds?.some((edgeId) => edgeTarget.get(edgeId) === nodeId)) {
        return `Cannot add an approval gate: this node is a consensus branch target of "${n.name}". Map and consensus branches run inline with no queue boundary to pause at.`;
      }
    }
  }

  if (mapTargetId) {
    const target = nodeById.get(mapTargetId);
    if (target?.approvalConfig) {
      return `Cannot set map target to "${target.name}": it has an approval gate configured. A gated node cannot be a fan-out branch target.`;
    }
  }

  for (const edgeId of consensusEdgeIds) {
    const targetId = edgeTarget.get(edgeId);
    const target = targetId ? nodeById.get(targetId) : undefined;
    if (target?.approvalConfig) {
      return `Cannot include "${target.name}" in this consensus group: it has an approval gate configured. A gated node cannot be a fan-out branch target.`;
    }
  }

  return null;
}
