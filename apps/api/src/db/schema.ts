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

export const agentGraphs = pgTable("agent_graphs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
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
  role: text("role").notNull(), // "supervisor" | "worker" | "router"
  provider: text("provider").notNull(), // ProviderId
  model: text("model").notNull(),
  systemPrompt: text("system_prompt").notNull().default(""),
  description: text("description").notNull().default(""),
  tools: jsonb("tools").notNull().default([]),
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
  kind: text("kind").notNull(), // "explicit" | "auto"
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
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
