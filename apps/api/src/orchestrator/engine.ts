import { generateText } from "ai";
import { eq, desc } from "drizzle-orm";
import { getModel } from "@openbots/providers";
import type { AgentGraph, AgentNode } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { agentGraphs, agentNodes, routingEdges, runEvents, runs } from "../db/schema.js";
import { resolveNextHop } from "./resolve.js";
import { withNodeTimeout } from "./circuitBreaker.js";
import { withRetry } from "./retry.js";
import { getCredentials } from "./credentials.js";
import { enqueueHop } from "../queue/runQueue.js";
import { publishRunEvent } from "../ws/publish.js";

/**
 * Dispatches exactly one hop for a run, then either enqueues the next hop
 * or completes the run. This is the whole orchestration engine: there is no
 * function that "plans a run" up front. Routing is resolved fresh on every
 * call to resolveNextHop, which is what lets a canvas edit change a live
 * run's path without ever cancelling an in-flight model call.
 *
 * Each hop also runs behind its own timeout (circuitBreaker.ts) and as its
 * own BullMQ job, so one hung node fails only its own run — it can't stall
 * sibling nodes or other runs sharing the same worker pool.
 */
export async function dispatchHop(runId: string): Promise<void> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status === "completed" || run.status === "error" || run.status === "cancelled") {
    return;
  }
  if (!run.currentNodeId) {
    throw new Error(`Run ${runId} has no currentNodeId set`);
  }

  const graph = await loadGraphForRun(run.graphId, run.mode, run.graphSnapshot);
  const node = graph.nodes.find((n) => n.id === run.currentNodeId);
  if (!node) throw new Error(`Node ${run.currentNodeId} not found in graph ${graph.id}`);

  await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));

  const sequence = await nextSequence(runId);
  const startedAt = new Date();
  publishRunEvent({ runId, type: "hop_dispatched", nodeId: node.id });

  let output: string;
  try {
    output = await withNodeTimeout(node.id, () => callAgent(node, run.input));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.insert(runEvents).values({
      runId,
      nodeId: node.id,
      sequence,
      status: "failed",
      input: run.input,
      error,
      startedAt,
      finishedAt: new Date(),
    });
    await db.update(runs).set({ status: "error", updatedAt: new Date() }).where(eq(runs.id, runId));
    publishRunEvent({ runId, type: "hop_failed", nodeId: node.id, payload: { error } });
    return;
  }

  const { edge, nextNodeId } = resolveNextHop(graph, node.id, output);

  await db.insert(runEvents).values({
    runId,
    nodeId: node.id,
    sequence,
    status: "succeeded",
    resolvedEdgeId: edge?.id ?? null,
    input: run.input,
    output,
    startedAt,
    finishedAt: new Date(),
  });
  publishRunEvent({ runId, type: "hop_succeeded", nodeId: node.id, payload: { output } });

  if (!nextNodeId) {
    await db
      .update(runs)
      .set({ status: "completed", output, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(runs.id, runId));
    publishRunEvent({ runId, type: "run_completed", payload: { output } });
    return;
  }

  await db
    .update(runs)
    .set({ currentNodeId: nextNodeId, input: output, updatedAt: new Date() })
    .where(eq(runs.id, runId));
  await enqueueHop(runId);
}

async function callAgent(node: AgentNode, input: unknown): Promise<string> {
  const credentials = getCredentials(node.provider);
  const model = getModel(node.provider, node.model, credentials);
  const prompt = typeof input === "string" ? input : JSON.stringify(input);
  const { text } = await withRetry(() =>
    generateText({ model, system: node.systemPrompt, prompt }),
  );
  return text;
}

async function nextSequence(runId: string): Promise<number> {
  const [last] = await db
    .select({ sequence: runEvents.sequence })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  return (last?.sequence ?? -1) + 1;
}

async function loadGraphForRun(
  graphId: string,
  mode: string,
  snapshot: unknown,
): Promise<AgentGraph> {
  if (mode === "pinned") {
    if (!snapshot) throw new Error(`Pinned run for graph ${graphId} has no snapshot`);
    return snapshot as AgentGraph;
  }
  return loadLiveGraph(graphId);
}

/** Reads the current graph straight from Postgres — used by "live" runs. */
export async function loadLiveGraph(graphId: string): Promise<AgentGraph> {
  const graphRow = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
  if (!graphRow) throw new Error(`Graph ${graphId} not found`);

  const nodes = await db.select().from(agentNodes).where(eq(agentNodes.graphId, graphId));
  const edges = await db.select().from(routingEdges).where(eq(routingEdges.graphId, graphId));

  return {
    id: graphRow.id,
    name: graphRow.name,
    description: graphRow.description,
    entryNodeId: graphRow.entryNodeId,
    version: graphRow.version,
    createdAt: graphRow.createdAt.toISOString(),
    updatedAt: graphRow.updatedAt.toISOString(),
    nodes: nodes.map((n) => ({
      id: n.id,
      graphId: n.graphId,
      name: n.name,
      role: n.role as AgentNode["role"],
      provider: n.provider as AgentNode["provider"],
      model: n.model,
      systemPrompt: n.systemPrompt,
      description: n.description,
      tools: n.tools as string[],
      position: { x: n.positionX, y: n.positionY },
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      graphId: e.graphId,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      kind: e.kind as "explicit" | "auto",
      condition: e.condition as AgentGraph["edges"][number]["condition"],
      priority: e.priority,
      label: e.label ?? undefined,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
  };
}
