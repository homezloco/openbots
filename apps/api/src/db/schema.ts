import {
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
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
  status: text("status").notNull().default("pending"), // "pending" | "completed" | "error"
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

export const userCredentials = pgTable("user_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  label: text("label").notNull().default(""),
  /** AES-256-GCM ciphertext, base64 — see auth/crypto.ts. Never returned by any API response. */
  encryptedKey: text("encrypted_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
