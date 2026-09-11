import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Mirrors the shapes in @openbots/graph-schema. That package owns validation
 * (zod) and the wire/runtime types; this file owns persistence only — keep
 * the two in sync by hand when either changes, there is no codegen link.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  /** scrypt hash, see auth/password.ts — never selected into API responses. */
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentGraphs = pgTable("agent_graphs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  entryNodeId: uuid("entry_node_id"),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentNodes = pgTable("agent_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").notNull(), // "supervisor" | "worker" | "router" | "reviewer"
  provider: text("provider").notNull(), // ProviderId
  model: text("model").notNull(),
  tier: text("tier"), // "flagship" | "standard" | "economy" | null
  systemPrompt: text("system_prompt").notNull().default(""),
  description: text("description").notNull().default(""),
  tools: jsonb("tools").notNull().default([]),
  fileAccessRoot: text("file_access_root"), // absolute dir path the read_file/list_directory tools are confined to
  fallbackChain: jsonb("fallback_chain").notNull().default([]), // FallbackTarget[]
  consensusGroup: jsonb("consensus_group"), // ConsensusGroup | null
  dispatchTargets: jsonb("dispatch_targets"), // string[] (graph ids) | null — see orchestrator/dispatchTool.ts
  sshTarget: jsonb("ssh_target"), // {host, username, allowedCommands: {label, command}[]} | null — see orchestrator/remoteCommandTool.ts
  mcpServers: jsonb("mcp_servers"), // McpServer[] | null — see orchestrator/mcpTool.ts (PR 2) and validation/mcpServer.ts
  positionX: real("position_x").notNull().default(0),
  positionY: real("position_y").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const routingEdges = pgTable("routing_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  sourceNodeId: uuid("source_node_id")
    .notNull()
    .references(() => agentNodes.id, { onDelete: "cascade" }),
  targetNodeId: uuid("target_node_id")
    .notNull()
    .references(() => agentNodes.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // "explicit" | "auto" | "consensus"
  condition: text("condition").notNull().default("default"),
  priority: integer("priority").notNull().default(0),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const routingChanges = pgTable("routing_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  changeType: text("change_type").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  graphVersion: integer("graph_version").notNull(),
  changedBy: text("changed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(), // "pinned" | "live"
  graphSnapshot: jsonb("graph_snapshot"), // set iff mode === "pinned"
  status: text("status").notNull().default("pending"),
  currentNodeId: uuid("current_node_id"),
  // Set iff this run was created by a scheduled trigger firing (orchestrator/
  // scheduledTrigger.ts) rather than a manual POST /runs call. set null on
  // trigger delete so the run's own history survives the schedule that
  // created it being removed later.
  scheduledTriggerId: uuid("scheduled_trigger_id").references(() => scheduledTriggers.id, { onDelete: "set null" }),
  // How many dispatch_to_graph hops led to this run (0 = started manually or
  // by schedule, never by dispatch). Caps cross-graph dispatch cycles — see
  // orchestrator/dispatchTool.ts's MAX_DISPATCH_DEPTH.
  dispatchDepth: integer("dispatch_depth").notNull().default(0),
  // Set iff this run was created by dispatch_to_graph, to the DISPATCHING
  // node's own graphId — lets check_dispatch_status find "the run I fired
  // into graph X" later without trusting anything the model remembers from
  // its own tool-call output. set null on the source graph's deletion, same
  // "survive the thing that created it" shape as scheduledTriggerId above.
  dispatchSourceGraphId: uuid("dispatch_source_graph_id").references(() => agentGraphs.id, { onDelete: "set null" }),
  input: jsonb("input"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(), // "dispatched" | "succeeded" | "failed" | "timeout"
  resolvedEdgeId: uuid("resolved_edge_id"),
  fanoutBatchId: uuid("fanout_batch_id"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const fanoutBatches = pgTable("fanout_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  aggregatorNodeId: uuid("aggregator_node_id").notNull(),
  totalBranches: integer("total_branches").notNull(),
  completedBranches: integer("completed_branches").notNull().default(0),
  status: text("status").notNull().default("pending"), // "pending" | "completed" | "partial" | "error"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerCredentials = pgTable("provider_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  /** Null = applies to any node in the graph using this provider; set = overrides for one node only. */
  nodeId: uuid("node_id").references(() => agentNodes.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  label: text("label").notNull().default(""),
  /** AES-256-GCM ciphertext, base64 — see auth/crypto.ts. Never returned by any API response. */
  encryptedKey: text("encrypted_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  estimatedCostUsd: real("estimated_cost_usd").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTemplates = pgTable("agent_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Self-contained AgentGraph snapshot (nodes/edges embedded), not a live reference. */
  graph: jsonb("graph").notNull(),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentCommits = pgTable("agent_commits", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha").notNull(),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const remoteCommandRuns = pgTable("remote_command_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  commandLabel: text("command_label").notNull(),
  command: text("command").notNull(),
  exitCode: integer("exit_code"),
  output: text("output").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const userCredentials = pgTable(
  "user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull().default(""),
    /** AES-256-GCM ciphertext, base64 — see auth/crypto.ts. Never returned by any API response. */
    encryptedKey: text("encrypted_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Required for routes/userCredentials.ts's onConflictDoUpdate({target: [userId, provider]})
  // to mean anything — Postgres's ON CONFLICT needs a real unique/exclusion
  // constraint matching the target columns, not just application-level intent.
  (table) => [unique().on(table.userId, table.provider)],
);

/**
 * A repeatable BullMQ "job scheduler" fires job.data.triggerId on this
 * row's cronExpression; the worker re-reads this row fresh on every
 * firing rather than trusting anything captured when the schedule was
 * registered (see orchestrator/scheduledTrigger.ts) — enabled/disabled,
 * input, and mode can all change between when a firing was scheduled and
 * when it actually runs. `id` is generated client-side (not
 * defaultRandom()) so the same value can be used as BullMQ's
 * jobSchedulerId — see queue/scheduleQueue.ts.
 */
export const scheduledTriggers = pgTable("scheduled_triggers", {
  id: uuid("id").primaryKey(),
  graphId: uuid("graph_id")
    .notNull()
    .references(() => agentGraphs.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  input: jsonb("input").notNull(),
  mode: text("mode").notNull().default("pinned"), // "pinned" | "live"
  cronExpression: text("cron_expression").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lastRunId: uuid("last_run_id"),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
