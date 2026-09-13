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

  // Edges into a consensus aggregator never fire on a sequential hop
  // (resolveNextHop skips them — aggregator only runs on ALL). Flag the
  // leftover specialist → reviewer edges the team graphs were built with.
  const aggregatorIds = new Set(
    graph.nodes.map((n) => n.consensusGroup?.aggregatorNodeId).filter((id): id is string => Boolean(id)),
  );
  for (const id of aggregatorIds) {
    const agg = graph.nodes.find((n) => n.id === id);
    const inbound = graph.edges.filter((e) => e.targetNodeId === id && e.kind === "explicit");
    if (agg && inbound.length > 0) {
      warnings.push(
        `"${agg.name}" is a consensus aggregator — explicit edges into it are ignored on single-specialist routes (it only runs on ALL).`,
      );
    }
    const outboundAuto = graph.edges.filter((e) => e.sourceNodeId === id && e.kind === "auto");
    if (agg && outboundAuto.length > 0) {
      warnings.push(
        `"${agg.name}" has outgoing auto edges; aggregator hops are terminal, so those edges never fire.`,
      );
    }
  }

  // A node with no edge touching it at all (as source or target) never
  // runs unless it's the entry node — silently dead weight on the canvas.
  // Most likely to happen from generated graphs (see routes/generateGraph.ts):
  // an LLM that names every node correctly but drops an edge for one of
  // them produces exactly this. Soft nudge only, same as every other check
  // here — the user can always wire it by hand on the live canvas.
  const touchedNodeIds = new Set<string>();
  for (const edge of graph.edges) {
    touchedNodeIds.add(edge.sourceNodeId);
    touchedNodeIds.add(edge.targetNodeId);
  }
  for (const node of graph.nodes) {
    if (node.id === graph.entryNodeId) continue;
    if (!touchedNodeIds.has(node.id)) {
      warnings.push(`"${node.name}" has no routing edges connecting it — it will never run.`);
    }
  }

  return warnings;
}
