import type { AgentGraph, RoutingEdge } from "@openbots/graph-schema";

/**
 * Core de-risking move for drag-and-drop rerouting: this is called fresh
 * before every hop, never planned ahead for a whole run. A canvas edit just
 * changes what this function returns on its NEXT call — no in-flight model
 * call is ever touched or cancelled. See docs/orchestration.md.
 *
 * `graph` is either the run's pinned snapshot or the live current graph,
 * depending on Run.mode — the caller decides which to pass in.
 */
export function resolveNextHop(
  graph: AgentGraph,
  currentNodeId: string,
  lastOutput: unknown,
): { edge: RoutingEdge | null; nextNodeId: string | null } {
  const outgoing = graph.edges.filter((e) => e.sourceNodeId === currentNodeId);
  if (outgoing.length === 0) {
    return { edge: null, nextNodeId: null };
  }

  const explicit = outgoing
    .filter((e) => e.kind === "explicit")
    .sort((a, b) => b.priority - a.priority);
  if (explicit.length > 0) {
    const chosen = explicit[0];
    return { edge: chosen, nextNodeId: chosen.targetNodeId };
  }

  const auto = outgoing.filter((e) => e.kind === "auto");
  if (auto.length > 0) {
    const chosen = matchAutoEdge(graph, auto, lastOutput);
    return { edge: chosen, nextNodeId: chosen?.targetNodeId ?? null };
  }

  return { edge: null, nextNodeId: null };
}

/**
 * Grok-style implicit delegation: pick the candidate whose target
 * description best overlaps the current output, by keyword matching. This
 * is a first pass modeled on the keyword-scoring layer of local-code's
 * ClassificationRouter — that project layers keyword scoring -> a trained
 * classifier -> learned corrections -> an LLM fallback. Swap in later
 * layers here before relying on "auto" edges in production; keeping the
 * interface stable means the canvas and engine don't change when it's
 * replaced (see docs/orchestration.md).
 */
function matchAutoEdge(
  graph: AgentGraph,
  candidates: RoutingEdge[],
  lastOutput: unknown,
): RoutingEdge | null {
  // The router is explicitly saying "I can't tell" (see engine.ts's
  // appendAutoRoutingContext, which teaches every auto-routing node this
  // convention) — treat that as no match rather than guessing anyway.
  // Found as a real bug: a genuine clarifying question that happened to
  // name several candidates by name (since the injected context lists
  // them) would win the keyword-overlap contest below purely by accident,
  // silently continuing the run instead of surfacing the question.
  const text = typeof lastOutput === "string" ? lastOutput : JSON.stringify(lastOutput ?? "");
  if (/^\s*unknown\b/i.test(text)) return null;

  if (candidates.length <= 1) return candidates[0] ?? null;

  const outputTokens = tokenize(text);
  if (outputTokens.size === 0) return null;

  let best: RoutingEdge | null = null;
  let bestScore = 0;
  for (const edge of candidates) {
    const target = graph.nodes.find((n) => n.id === edge.targetNodeId);
    const score = overlapScore(outputTokens, tokenize(target?.description ?? ""));
    if (score > 0 && (score > bestScore || (score === bestScore && edge.priority > (best?.priority ?? -Infinity)))) {
      best = edge;
      bestScore = score;
    }
  }
  return best;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count++;
  return count;
}
