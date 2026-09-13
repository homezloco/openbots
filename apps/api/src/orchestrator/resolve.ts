import type { AgentGraph, RoutingEdge } from "@openbots/graph-schema";

/** Node ids that exist only as a consensus join — they run via dispatchConsensus, never as a sequential next hop. */
export function aggregatorNodeIds(graph: AgentGraph): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.consensusGroup?.aggregatorNodeId) ids.add(n.consensusGroup.aggregatorNodeId);
  }
  return ids;
}

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

  const aggregators = aggregatorNodeIds(graph);

  const explicit = outgoing
    .filter((e) => e.kind === "explicit")
    .sort((a, b) => b.priority - a.priority);
  if (explicit.length > 0) {
    const chosen = explicit[0];
    // Specialist → sign-off-reviewer explicit edges are a common mistaken
    // encoding of "review after every hop". The reviewer is the consensus
    // aggregator and expects a JSON array of {nodeId, output} — dumping a
    // single specialist's prose there is what produced Loudest's
    // "this doesn't match the expected input format" UNKNOWN. Aggregators
    // only run via dispatchConsensus.
    if (aggregators.has(chosen.targetNodeId)) {
      return { edge: null, nextNodeId: null };
    }
    return { edge: chosen, nextNodeId: chosen.targetNodeId };
  }

  const auto = outgoing.filter((e) => e.kind === "auto");
  if (auto.length > 0) {
    const chosen = matchAutoEdge(graph, auto, lastOutput);
    if (chosen && aggregators.has(chosen.targetNodeId)) {
      return { edge: null, nextNodeId: null };
    }
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
/**
 * True when `text` starts (after optional leading whitespace) with `word`
 * followed by whitespace or common sentence punctuation — not just any
 * word-boundary. A plain `\b` check false-positives on a specialist
 * literally named e.g. "All-Projects-Dashboard" or "Unknown-Config-Bot",
 * since "-" already counts as a non-word boundary. Shared by matchAutoEdge's
 * UNKNOWN check and engine.ts's ALL fan-out check — one place that knows
 * how to parse this sentinel-prefix convention.
 */
export function startsWithSentinel(text: unknown, word: string): boolean {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return new RegExp(`^\\s*${word}(?=[\\s,.:;!]|$)`, "i").test(s);
}

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
  if (startsWithSentinel(text, "unknown")) return null;

  // Symmetric to UNKNOWN, for the opposite accidental-overlap direction:
  // a router that already gave a complete final answer (e.g. relaying a
  // tool's success or error) can still name a specialist inside that
  // answer — "this looks like something the Backend Specialist should
  // investigate" — which then wins the keyword-overlap contest below on
  // an exact name match and silently auto-routes there, discarding the
  // router's own good answer in favor of that specialist's unrelated,
  // often incomplete response. DONE lets a router explicitly opt out of
  // further routing on a hop that happens to mention a target by name
  // without intending to hand off. Found as a real bug: a business-
  // metrics-capable lead's own error-reporting text named the specialist
  // it suggested the user loop in, which auto-routed there instead of
  // surfacing the lead's actual answer.
  if (startsWithSentinel(text, "done")) return null;

  // Both sentinels above depend on the MODEL COMPLYING with a convention
  // engine.ts injects. Frontier models generally do; smaller ones often
  // don't — measured against a local Gemma 4 E4B, which correctly
  // recognized an ambiguous request and asked a clarifying question, but
  // phrased it in plain prose with no UNKNOWN prefix. The question named
  // both specialists while offering them as options, so the keyword
  // scoring below matched one and the run silently continued, throwing
  // the user's question away — exactly the failure the UNKNOWN sentinel
  // was introduced to prevent, just reached by a different route.
  //
  // So: also detect the ambiguity STRUCTURALLY, independent of whether
  // the model followed protocol. If the router ENDS ITS TURN ASKING, the
  // question is the output that matters and the user needs to see it —
  // routing onward would discard it, which is the whole bug.
  //
  // Deliberately keyed on a TRAILING "?" rather than one appearing
  // anywhere: an earlier attempt here fired on "names 2+ candidates AND
  // contains a question mark", which looked reasonable but wrongly
  // swallowed a decisive answer phrased with a rhetorical lead-in ("Is it
  // a crash? No. This is the Billing Specialist's area, not the Technical
  // Specialist's."). The mock-tier suite catches that case specifically.
  // Ending on a question is the honest signal; containing one is not.
  if (/\?\s*$/.test(text)) return null;

  if (candidates.length <= 1) return candidates[0] ?? null;

  const outputTokens = tokenize(text);
  if (outputTokens.size === 0) return null;

  let best: RoutingEdge | null = null;
  let bestScore = 0;
  for (const edge of candidates) {
    const target = graph.nodes.find((n) => n.id === edge.targetNodeId);
    // Name AND description: appendAutoRoutingContext tells the router to
    // mention the target's exact name, but scoring description-only meant
    // "Loudest Backend Specialist" tied on the shared token "loudest" and
    // the first auto edge (Frontend) won — a real misroute.
    const score = overlapScore(outputTokens, tokenize(`${target?.name ?? ""} ${target?.description ?? ""}`));
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
