import { z } from "zod";

/**
 * Providers are adapted behind one interface in @openbots/providers.
 * "openai-compatible" covers any self-hosted or third-party endpoint that
 * speaks the OpenAI chat-completions wire format (Ollama, Groq, Together, etc).
 */
export const ProviderId = z.enum([
  "anthropic",
  "openai",
  "xai",
  "openrouter",
  "openai-compatible",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const AgentRole = z.enum(["supervisor", "worker", "router"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const CanvasPosition = z.object({
  x: z.number(),
  y: z.number(),
});
export type CanvasPosition = z.infer<typeof CanvasPosition>;

export const AgentNode = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  name: z.string().min(1),
  role: AgentRole,
  provider: ProviderId,
  model: z.string().min(1),
  systemPrompt: z.string().default(""),
  /**
   * Short natural-language job description. Doubles as documentation and as
   * the match signal for "auto" edges (see RoutingEdgeKind) — mirrors the
   * low-friction Grok Bot creation flow while staying inside an explicit,
   * inspectable graph.
   */
  description: z.string().default(""),
  tools: z.array(z.string()).default([]),
  position: CanvasPosition,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentNode = z.infer<typeof AgentNode>;

/**
 * "explicit" edges are hard-wired: the engine always takes them (subject to
 * `condition`/`priority` tie-breaking against sibling explicit edges).
 * "auto" edges are resolved at dispatch time by matching the run's current
 * output against candidate target descriptions (Grok-style implicit
 * delegation) — both kinds render on the same canvas, auto edges dashed.
 */
export const RoutingEdgeKind = z.enum(["explicit", "auto"]);
export type RoutingEdgeKind = z.infer<typeof RoutingEdgeKind>;

export const RoutingCondition = z.enum([
  "default",
  "on_tool_call",
  "on_classifier_result",
  "manual",
]);
export type RoutingCondition = z.infer<typeof RoutingCondition>;

export const RoutingEdge = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  kind: RoutingEdgeKind,
  condition: RoutingCondition.default("default"),
  /** Break ties among multiple explicit edges leaving the same source. */
  priority: z.number().int().default(0),
  label: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RoutingEdge = z.infer<typeof RoutingEdge>;

export const AgentGraph = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().default(""),
  nodes: z.array(AgentNode),
  edges: z.array(RoutingEdge),
  /** The node a new run starts at. Must reference a node in `nodes`. */
  entryNodeId: z.string().uuid().nullable(),
  /** Bumped on every node/edge mutation. Pinned runs snapshot this. */
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentGraph = z.infer<typeof AgentGraph>;

/**
 * Append-only audit trail for every graph edit, keyed to the version it
 * produced. This is what makes drag-and-drop rerouting reviewable/undoable
 * instead of a silent mutation.
 */
export const RoutingChangeType = z.enum([
  "node_added",
  "node_removed",
  "node_updated",
  "edge_added",
  "edge_removed",
  "edge_rerouted",
]);
export type RoutingChangeType = z.infer<typeof RoutingChangeType>;

export const RoutingChange = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  changeType: RoutingChangeType,
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  graphVersion: z.number().int().nonnegative(),
  changedBy: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type RoutingChange = z.infer<typeof RoutingChange>;

/**
 * "pinned" runs snapshot the graph at start (deterministic, replayable —
 * the Phase 1 default). "live" runs re-read the current graph before every
 * hop, so a canvas edit takes effect on the run's next dispatch without
 * ever touching an in-flight model call. See docs/orchestration.md.
 */
export const RunMode = z.enum(["pinned", "live"]);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  mode: RunMode,
  /** Present only when mode === "pinned". */
  graphSnapshot: AgentGraph.nullable(),
  status: RunStatus,
  currentNodeId: z.string().uuid().nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Run = z.infer<typeof Run>;

export const RunEventStatus = z.enum([
  "dispatched",
  "succeeded",
  "failed",
  "timeout",
]);
export type RunEventStatus = z.infer<typeof RunEventStatus>;

/**
 * One row per node dispatch within a run. Drives both replay and the live
 * WebSocket feed that lights up the canvas during execution.
 */
export const RunEvent = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  status: RunEventStatus,
  /** The edge taken to reach this node; null for the run's starting node. */
  resolvedEdgeId: z.string().uuid().nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type RunEvent = z.infer<typeof RunEvent>;
