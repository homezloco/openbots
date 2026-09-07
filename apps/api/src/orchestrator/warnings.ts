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

  return warnings;
}
