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

/**
 * "reviewer" is a distinct role (not just a worker with a review-flavored
 * prompt) so the engine and canvas can identify review hops explicitly —
 * see ModelTier below for the guard this makes possible.
 */
export const AgentRole = z.enum(["supervisor", "worker", "router", "reviewer"]);
export type AgentRole = z.infer<typeof AgentRole>;

/**
 * Self-declared, not inferred: OpenBots does not maintain a "which models
 * are strongest" ranking (it would go stale immediately, the same problem
 * documented for provider adapters). The user tags each node's model once;
 * the canvas warns — never blocks — when a reviewer's tier is lower than
 * a node it reviews. See docs/orchestration.md.
 */
export const ModelTier = z.enum(["flagship", "standard", "economy"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const CanvasPosition = z.object({
  x: z.number(),
  y: z.number(),
});
export type CanvasPosition = z.infer<typeof CanvasPosition>;

/** One fallback attempt: tried in order after the node's primary provider/model fails with a classified auth/model error. */
export const FallbackTarget = z.object({
  provider: ProviderId,
  model: z.string().min(1),
});
export type FallbackTarget = z.infer<typeof FallbackTarget>;

/**
 * Marks a node as a fan-out/aggregate ("consensus") point: every edge in
 * `edgeIds` (all must be RoutingEdgeKind "consensus" edges from this node)
 * fires concurrently with the same input, and once every branch finishes,
 * `aggregatorNodeId` is dispatched once with all branch outputs as input.
 * The engine only handles the fan-out/join mechanics; the aggregator (an
 * ordinary agent node) makes the actual consensus judgment call — see
 * docs/orchestration.md.
 */
export const ConsensusGroup = z.object({
  edgeIds: z.array(z.string().uuid()).min(2),
  aggregatorNodeId: z.string().uuid(),
});
export type ConsensusGroup = z.infer<typeof ConsensusGroup>;

export const AgentNode = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  name: z.string().min(1),
  role: AgentRole,
  provider: ProviderId,
  model: z.string().min(1),
  tier: ModelTier.optional(),
  systemPrompt: z.string().default(""),
  /**
   * Short natural-language job description. Doubles as documentation and as
   * the match signal for "auto" edges (see RoutingEdgeKind) — mirrors the
   * low-friction Grok Bot creation flow while staying inside an explicit,
   * inspectable graph.
   */
  description: z.string().default(""),
  tools: z.array(z.string()).default([]),
  /**
   * Absolute directory path this node's file-reading tools ("read_file",
   * "list_directory") are confined to — every resolved path is checked to
   * stay within this root before any read happens, so a "worker" tool
   * name in `tools` alone is not enough to grant filesystem access. Unset
   * means no file access regardless of what's in `tools`. See
   * docs/adapters.md for the security reasoning.
   */
  fileAccessRoot: z.string().optional(),
  fallbackChain: z.array(FallbackTarget).default([]),
  consensusGroup: ConsensusGroup.optional(),
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
 * delegation). "consensus" edges only fire as part of their source node's
 * `consensusGroup` fan-out — both of the other kinds render solid/dashed on
 * the canvas, consensus edges render grouped/dotted.
 */
export const RoutingEdgeKind = z.enum(["explicit", "auto", "consensus"]);
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
  ownerId: z.string().nullable(),
  nodes: z.array(AgentNode),
  edges: z.array(RoutingEdge),
  /** The node a new run starts at. Must reference a node in `nodes`. */
  entryNodeId: z.string().uuid().nullable(),
  /** Bumped on every node/edge mutation. Pinned runs snapshot this. */
  version: z.number().int().nonnegative(),
  /**
   * Computed at read time, never persisted — e.g. "reviewer's declared
   * tier is lower than a node it reviews." Soft nudges only; nothing here
   * ever blocks a save or a run. See ModelTier.
   */
  warnings: z.array(z.string()).default([]),
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
  /** Set when this hop is one branch of a consensus fan-out; groups sibling branches for the join. */
  fanoutBatchId: z.string().uuid().nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type RunEvent = z.infer<typeof RunEvent>;

/**
 * Tracks one consensus fan-out's join progress. `run_events` rows with a
 * matching `fanoutBatchId` are the branches; once `completedBranches`
 * reaches `totalBranches`, the engine dispatches `aggregatorNodeId` with
 * every branch's output. See ConsensusGroup and docs/orchestration.md.
 */
export const FanoutBatch = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  aggregatorNodeId: z.string().uuid(),
  totalBranches: z.number().int().positive(),
  completedBranches: z.number().int().nonnegative(),
  status: z.enum(["pending", "completed", "error"]),
  createdAt: z.string().datetime(),
});
export type FanoutBatch = z.infer<typeof FanoutBatch>;

/** Public user profile — never carries a password hash or session secret. */
export const PublicUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});
export type PublicUser = z.infer<typeof PublicUser>;

/** API-facing view of a stored provider credential — the secret itself never leaves the server. */
export const ProviderCredentialSummary = z.object({
  id: z.string().uuid(),
  graphId: z.string().uuid(),
  nodeId: z.string().uuid().nullable(),
  provider: ProviderId,
  label: z.string(),
  createdAt: z.string().datetime(),
});
export type ProviderCredentialSummary = z.infer<typeof ProviderCredentialSummary>;

/** One recorded model call's token/cost accounting, for per-run and per-node usage rollups. */
export const UsageEvent = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string().uuid(),
  provider: ProviderId,
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Best-effort estimate from a hand-maintained price table (see docs/adapters.md) — not a billing-grade figure. */
  estimatedCostUsd: z.number().nonnegative(),
  createdAt: z.string().datetime(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** A graph exported as a reusable starting point — nodes/edges are a self-contained snapshot, not live references. */
export const AgentTemplate = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().default(""),
  graph: AgentGraph,
  authorId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AgentTemplate = z.infer<typeof AgentTemplate>;
