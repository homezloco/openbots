import type { ConsensusGroup, MapConfig } from "@openbots/graph-schema";

/**
 * A map's `aggregatorNodeId` pointing at the SOURCE node itself is a real
 * infinite-loop hazard, not just a confusing config: dispatchHop checks
 * `mapConfig` before the aggregator-terminal path (see engine.ts), so a
 * node reached as its own aggregator re-parses its own output as a fresh
 * work list and fans out again, with no cycle guard or hop-count cap —
 * `resolveNextHop`'s `alreadyVisited` check only runs on the normal
 * single-edge routing path, never on this one. Runtime also now treats
 * a map aggregator the same as a consensus one (aggregatorNodeIds in
 * resolve.ts), which closes the general class of cycles; this closes the
 * specific, always-nonsensical self-reference at save time instead of
 * relying on that alone. `targetNodeId === nodeId` is rejected too — a
 * node "mapping over itself" as the per-item worker has no valid use and
 * is the same category of self-referential footgun.
 */
export function checkMapConfigNotSelfReferential(nodeId: string | null, mapConfig: MapConfig | null | undefined): string | null {
  if (!mapConfig || !nodeId) return null;
  if (mapConfig.targetNodeId === nodeId) {
    return "mapConfig.targetNodeId cannot be this node itself — a map target must be a different node.";
  }
  if (mapConfig.aggregatorNodeId === nodeId) {
    return "mapConfig.aggregatorNodeId cannot be this node itself — that would re-trigger the same fan-out indefinitely, with no cycle guard on this path.";
  }
  return null;
}

/**
 * Same hazard, same fix, for consensus: a self-referential
 * `aggregatorNodeId` is worse here than for map, since a pure consensus
 * source with no auto edges re-triggers dispatchConsensus unconditionally
 * on EVERY hop (see the "bypasses normal routing unconditionally"
 * comment in engine.ts), not just when the output happens to parse as
 * something — self-reference here is an immediate, guaranteed infinite
 * loop the very first time the node is dispatched.
 */
export function checkConsensusGroupNotSelfReferential(nodeId: string | null, consensusGroup: ConsensusGroup | null | undefined): string | null {
  if (!consensusGroup || !nodeId) return null;
  if (consensusGroup.aggregatorNodeId === nodeId) {
    return "consensusGroup.aggregatorNodeId cannot be this node itself — for a source with no auto edges this re-triggers the fan-out on every single hop, unconditionally.";
  }
  return null;
}
