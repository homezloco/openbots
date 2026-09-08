import type { AgentGraph, ModelTier } from "@openbots/graph-schema";

const TIER_RANK: Record<ModelTier, number> = { economy: 0, standard: 1, flagship: 2 };

/**
 * Soft, self-declared-tier nudge only — never a block. See ModelTier in
 * @openbots/graph-schema for why OpenBots doesn't maintain its own
 * model-capability ranking.
 */
export function computeWarnings(graph: AgentGraph): string[] {
  const warnings: string[] = [];

  for (const reviewer of graph.nodes.filter((n) => n.role === "reviewer" && n.tier)) {
    for (const edge of graph.edges.filter((e) => e.targetNodeId === reviewer.id)) {
      const source = graph.nodes.find((n) => n.id === edge.sourceNodeId);
      if (source?.tier && TIER_RANK[reviewer.tier!] < TIER_RANK[source.tier]) {
        warnings.push(
          `Reviewer "${reviewer.name}" is tier "${reviewer.tier}", lower than "${source.name}" (tier "${source.tier}") which it reviews.`,
        );
      }
    }
  }

  // A hybrid node (auto edges + a consensusGroup, see engine.ts's ALL
  // fan-out) whose consensusGroup doesn't cover every one of its own auto
  // edges silently breaks the user-facing "ALL means all of them" promise
  // — e.g. adding a 9th specialist and forgetting to add it to the fan-out
  // set. Soft nudge only, same as the reviewer/tier check above: no
  // enforced coverage, consistent with how loosely-validated
  // consensusGroup already is elsewhere.
  for (const node of graph.nodes.filter((n) => n.consensusGroup)) {
    const autoEdgeIds = graph.edges
      .filter((e) => e.sourceNodeId === node.id && e.kind === "auto")
      .map((e) => e.id);
    if (autoEdgeIds.length === 0) continue;
    const covered = new Set(node.consensusGroup!.edgeIds);
    const missing = autoEdgeIds.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      warnings.push(
        `"${node.name}"'s ALL fan-out covers ${covered.size} of its ${autoEdgeIds.length} auto-routing targets.`,
      );
    }
  }

  return warnings;
}
