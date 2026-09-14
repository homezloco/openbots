import { z } from "zod";

/**
 * Providers are adapted behind one interface in @openbots/providers.
 * "openai-compatible" covers any self-hosted or third-party endpoint that
 * speaks the OpenAI chat-completions wire format (Ollama, Groq, Together, etc).
 * "mock" makes no network call and needs no credentials at all — a
 * deterministic stand-in so tests can exercise routing/orchestration
 * without billed API calls (see packages/providers/src/registry.ts).
 * "transform" is likewise a deterministic non-LLM node — no model call,
 * zero cost: the model id selects the operation (e.g. "template",
 * "uppercase", "extract-json") and the systemPrompt carries that
 * operation's config (see packages/providers/src/registry.ts).
 */
export const ProviderId = z.enum([
  "anthropic",
  "openai",
  "xai",
  "openrouter",
  "openai-compatible",
  "mock",
  "transform",
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
 * `edgeIds` fires concurrently with the same input, and once every branch
 * finishes, `aggregatorNodeId` is dispatched once with all branch outputs
 * as input. The engine only handles the fan-out/join mechanics; the
 * aggregator (an ordinary agent node) makes the actual consensus judgment
 * call — see docs/orchestration.md.
 *
 * `edgeIds` don't have to be RoutingEdgeKind "consensus" edges — they can
 * be a node's existing "auto" edges instead, which makes that node a
 * hybrid: single-target auto routing by default, fanning out via this
 * group only when the model's own output signals the request spans
 * multiple/all targets (the "ALL" sentinel convention, symmetric to
 * "UNKNOWN" — see engine.ts's appendAutoRoutingContext/dispatchHop). A
 * node with a consensusGroup and NO auto edges (the original pattern)
 * still fans out unconditionally on every hop.
 */
export const ConsensusGroup = z.object({
  edgeIds: z.array(z.string().uuid()).min(2),
  aggregatorNodeId: z.string().uuid(),
});
export type ConsensusGroup = z.infer<typeof ConsensusGroup>;

/**
 * A pre-approved command a node may invoke by label via "run_remote_command"
 * — see SshTarget below. The model only ever supplies `label`; the actual
 * `command` string is never model-visible or model-constructible.
 */
export const AllowedRemoteCommand = z.object({
  label: z.string().min(1),
  command: z.string().min(1),
});
export type AllowedRemoteCommand = z.infer<typeof AllowedRemoteCommand>;

/**
 * Grants a node the "run_remote_command" tool against exactly one SSH host,
 * restricted to an exact, pre-configured command per label — the same
 * dual-gate pattern as fileAccessRoot/dispatchTargets: the tool name in
 * `tools` alone grants nothing without this also being set, and vice versa.
 * `host` is re-verified against the operator's ALLOWED_SSH_HOSTS allowlist
 * at call time, never trusted from what was last saved — see
 * orchestrator/remoteCommandTool.ts.
 */
export const SshTarget = z.object({
  host: z.string().min(1),
  username: z.string().min(1),
  allowedCommands: z.array(AllowedRemoteCommand).default([]),
});
export type SshTarget = z.infer<typeof SshTarget>;

/**
 * One remote MCP server this node may call tools on. Dual-gate with
 * `"mcp"` in `tools[]`: this list alone grants nothing, and `"mcp"`
 * without servers is a no-op. URLs are re-checked against the operator
 * ALLOWED_MCP_SERVERS prefix allowlist at save AND at hop time (SSRF).
 * `allowedTools` is an exact-name allowlist of that server's MCP tools
 * — empty means zero tools, not all of them. Tokens live in
 * user_credentials (credentialProvider), never in this object.
 */
export const McpServer = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "slug must be 1-32 lowercase letters, digits, or hyphens"),
  url: z.string().url(),
  allowedTools: z.array(z.string().min(1)).default([]),
  credentialProvider: z.string().min(1).optional(),
  // Unset = Authorization: Bearer <token> (the original/default behavior).
  // Set = the raw token is sent under this header name instead, no
  // "Bearer " prefix — covers the dominant non-OAuth vendor pattern
  // (X-API-Key, api-key, etc.). .nullable() so PATCH can clear a
  // previously-set header back to the default, same reason
  // consensusGroup/sshTarget need .nullable().optional() rather than
  // .optional() alone.
  headerName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "must be a valid HTTP header name")
    .nullable()
    .optional(),
});
export type McpServer = z.infer<typeof McpServer>;

/**
 * One named REST endpoint this node may call via the http_request tool.
 * Dual-gate with `\"http_request\"` in `tools[]`: this list alone grants
 * nothing, and `\"http_request\"` without endpoints is a no-op. URLs are
 * re-checked against the operator ALLOWED_HTTP_ENDPOINTS prefix allowlist
 * at save AND at hop time (SSRF protection). Tokens live in user_credentials
 * (credentialProvider), never in this object.
 */
/**
 * Dynamic fan-out ("map"): run ONE target node once per item in a list the
 * previous hop produced at runtime, then hand every result to an
 * aggregator. The list length is unknown until the hop runs, which is
 * exactly what `consensusGroup` cannot express — that fans out to a FIXED
 * set of edge ids decided when the graph was authored.
 *
 * The two are deliberately separate rather than one merged concept:
 * consensus is "ask N DIFFERENT specialists the SAME question", map is
 * "ask ONE specialist the same question about N DIFFERENT items". They
 * share the join machinery (`fanout_batches`) and nothing else.
 *
 * `maxConcurrency` matters more here than for consensus: N is attacker-
 * or model-influenced rather than author-chosen, so an unbounded map over
 * a 500-item list would fire 500 concurrent model calls from a single
 * worker slot.
 */
export const MapConfig = z.object({
  /** The node run once per item. Receives the item as its whole input. */
  targetNodeId: z.string().uuid(),
  /** Receives the array of every branch result, like a consensus aggregator. */
  aggregatorNodeId: z.string().uuid(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  /** Refuses to start a map larger than this, rather than melting the worker. */
  maxItems: z.number().int().min(1).max(500).optional(),
});
export type MapConfig = z.infer<typeof MapConfig>;

/**
 * Marks a node as an approval gate: a run pauses BEFORE this node executes
 * and waits for a human to approve, edit, or cancel.
 *
 * This exists because OpenBots' existing approval mechanism doesn't
 * generalize. Agent file edits are safe to let run unsupervised because
 * git provides a staging layer — changes land in an isolated worktree and
 * reach nobody until a human runs /push. Network side effects have no
 * equivalent: `http_request` POSTs, `run_remote_command`, and MCP tool
 * calls take effect the instant the model makes them. There is no local
 * fork of someone else's CRM.
 *
 * The host allowlist answers "which hosts are reachable". It cannot answer
 * "should this particular message be sent", which is the actual question
 * when an agent is about to email a real customer.
 *
 * Scope, stated honestly: this gates ENTRY TO A NODE, not individual tool
 * calls. The reviewer approves the input about to be handed to a sending
 * node — not the exact HTTP payload, which doesn't exist until the model
 * composes it mid-hop. Gating a tool call would mean suspending inside
 * the generateText tool loop, which the one-hop-per-job design cannot
 * express. So the intended pattern is a node whose only job is to send.
 *
 * Cannot be combined with being a map target or consensus branch target:
 * those branches run inline inside one job with no queue boundary to
 * pause at (see orchestrator/engine.ts's dispatchMap/dispatchConsensus).
 * Rejected at save time rather than discovered at runtime. Gating the
 * AGGREGATOR is fine — it is dispatched through the queue normally.
 */
export const ApprovalConfig = z.object({
  /**
   * Shown to whoever reviews the paused run. Since the gate approves a
   * node's INPUT rather than its eventual side effect, this is how the
   * graph author explains what is actually about to happen.
   */
  instructions: z.string().max(2000).optional(),
  /**
   * Optional: a URL to POST when this gate trips, since `run_awaiting_approval`
   * is otherwise WebSocket-only and reaches nobody unless a browser tab
   * happens to be open — exactly the scheduled/webhook-triggered runs a
   * gate matters most for. Best-effort: delivery failures never affect
   * the run, which is already correctly paused regardless of whether
   * anyone was told. Must sit under an operator-configured prefix (see
   * ALLOWED_NOTIFICATION_WEBHOOKS) — re-checked at save time AND at
   * delivery time, same "config is a save-time convenience, not the
   * security boundary" pattern httpEndpoints/mcpServers/sshTarget follow.
   */
  notifyWebhookUrl: z.string().url().max(2048).optional(),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfig>;

export const HttpEndpoint = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "slug must be 1-32 lowercase letters, digits, or hyphens"),
  baseUrl: z.string().url(),
  credentialProvider: z.string().min(1).optional(),
  // Unset = Authorization: Bearer <token> (the original/default behavior).
  // Set = the raw token is sent under this header name instead, no
  // "Bearer " prefix — covers the dominant non-OAuth vendor pattern
  // (X-API-Key, api-key, etc.). .nullable() so PATCH can clear a
  // previously-set header back to the default, same reason
  // consensusGroup/sshTarget need .nullable().optional() rather than
  // .optional() alone.
  headerName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "must be a valid HTTP header name")
    .nullable()
    .optional(),
});
export type HttpEndpoint = z.infer<typeof HttpEndpoint>;

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
   * "list_directory", "search_knowledge") are confined to — every resolved path is checked to
   * stay within this root before any read happens, so a "worker" tool
   * name in `tools` alone is not enough to grant filesystem access. Unset
   * means no file access regardless of what's in `tools`. See
   * docs/adapters.md for the security reasoning.
   */
  fileAccessRoot: z.string().optional(),
  fallbackChain: z.array(FallbackTarget).default([]),
  consensusGroup: ConsensusGroup.optional(),
  /**
   * Graph ids this node may fire-and-forget dispatch into via the
   * "dispatch_to_graph" tool — same dual-gate pattern as fileAccessRoot:
   * the tool name in `tools` alone grants nothing without this also being
   * set, and vice versa. Re-verified against real ownership at call time
   * (see orchestrator/dispatchTool.ts) — this field is a UX/save-time
   * convenience, never the actual security boundary.
   */
  dispatchTargets: z.array(z.string().uuid()).optional(),
  /**
   * Grants "run_remote_command" against exactly one SSH host and its
   * pre-approved commands — see SshTarget. Unset means no remote-command
   * access regardless of what's in `tools`.
   */
  sshTarget: SshTarget.nullable().optional(),
  /**
   * Remote MCP servers this node may call, dual-gated with `"mcp"` in
   * tools[] — see McpServer. Unset/empty means no MCP access.
   */
  mcpServers: z.array(McpServer).optional(),
  /**
   * Named REST endpoints this node may call, dual-gated with
   * `"http_request"` in tools[] — see HttpEndpoint. Unset/empty means no
   * HTTP access regardless of what's in `tools`. The model only ever
   * supplies a slug from this list; it can never construct an arbitrary
   * URL, and every baseUrl is re-checked against ALLOWED_HTTP_ENDPOINTS
   * at hop time, not just at save time.
   */
  httpEndpoints: z.array(HttpEndpoint).optional(),
  /**
   * Turns this node into a dynamic fan-out source — see MapConfig. Unset
   * means normal single-target routing. `.nullable()` so PATCH can clear
   * it, same reason as consensusGroup.
   */
  mapConfig: MapConfig.nullable().optional(),
  /**
   * Pauses the run for human approval before this node runs — see
   * ApprovalConfig. Unset means the node runs normally. `.nullable()` so
   * PATCH can revoke a gate, same reason as consensusGroup: a grant (or
   * here, a guard) that can't be cleared is a one-way door.
   */
  approvalConfig: ApprovalConfig.nullable().optional(),
  position: CanvasPosition,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentNode = z.infer<typeof AgentNode>;

/**
 * "explicit" edges are hard-wired: the engine takes the highest-priority
 * one among its outgoing explicit edges whose `condition` is currently
 * satisfied (see resolve.ts::resolveNextHop) — a node with only
 * "default"-condition explicit edges keeps the original unconditional
 * behavior, since "default" is always satisfied. If NONE of a node's
 * explicit edges are satisfied (e.g. all are `on_tool_call` and no tool
 * ran this hop), resolution falls through to that node's `auto` edges
 * exactly as if it had no explicit edges at all, rather than dead-ending.
 * "auto" edges are resolved at dispatch time by matching the run's current
 * output against candidate target descriptions (Grok-style implicit
 * delegation). "consensus" edges only fire as part of their source node's
 * `consensusGroup` fan-out — both of the other kinds render solid/dashed on
 * the canvas, consensus edges render grouped/dotted.
 */
export const RoutingEdgeKind = z.enum(["explicit", "auto", "consensus"]);
export type RoutingEdgeKind = z.infer<typeof RoutingEdgeKind>;

/**
 * Only meaningful on `kind: "explicit"` edges — auto/consensus edges are
 * resolved by their own separate mechanisms and never consult this field.
 * See resolve.ts's `isConditionSatisfied` for the exact runtime check
 * each value maps to:
 *  - "default": always satisfied — the original unconditional behavior.
 *  - "on_tool_call": satisfied only when this hop's model call actually
 *    invoked at least one tool (see engine.ts::AgentCallResult.toolCalled).
 *  - "on_classifier_result": satisfied only when the hop's output text
 *    STARTS WITH this edge's (required) `label`, case-insensitively —
 *    lets one node have several explicit edges disambiguated by a fixed
 *    classification label, in addition to / instead of fuzzy `auto`
 *    keyword matching.
 *  - "manual": never satisfied automatically. Exists on the canvas as a
 *    structural connection a human wires up — e.g. so a drag-reroute has
 *    somewhere sanctioned to land — never something the engine follows
 *    on its own.
 */
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
  /**
   * Graph-wide default fallback chain. A node with its own (non-empty)
   * fallbackChain uses only that — this is never merged in, only used
   * when a node's own chain is empty. Also the retry list quick-add and
   * /graphs/generate use for the structured-generation call itself. Same
   * "specific → shared → environment-default" resolution shape
   * credentials.ts::getCredentials() already uses for API keys.
   */
  fallbackChain: z.array(FallbackTarget).default([]),
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
  /** condition/label/priority edited without changing targetNodeId — see PATCH /graphs/:id/edges/:edgeId. */
  "edge_updated",
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
  // A run paused before a gated node (AgentNode.approvalConfig) — waits
  // indefinitely for POST /runs/:id/approve or /cancel. See engine.ts's
  // advanceRun. Non-terminal: dispatchHop's terminal-status guard treats
  // it as "not over" but also refuses to execute the very hop it's
  // holding (a stale/duplicate job for a still-waiting run).
  "awaiting_approval",
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
  /** Present when this run was forked from another run's hop checkpoint. */
  forkedFromRunId: z.string().uuid().nullable().optional(),
  forkedFromSequence: z.number().int().nonnegative().nullable().optional(),
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
  // A human decision at an approval gate, not a node dispatch — recorded
  // as its own run_events row (nodeId = the gated node, input = the
  // original proposed input) so approve/cancel decisions are as
  // attributable as routing_changes already makes live reroutes. See
  // POST /runs/:id/approve and /cancel in routes/runs.ts.
  "approved",
  "cancelled",
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
