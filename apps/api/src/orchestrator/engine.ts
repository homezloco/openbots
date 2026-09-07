import { generateText, stepCountIs } from "ai";
import { eq, desc } from "drizzle-orm";
import { estimateCostUsd, getModel, resolveTools } from "@openbots/providers";
import type { AgentGraph, AgentNode, ProviderId } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import {
  agentGraphs,
  agentNodes,
  fanoutBatches,
  routingEdges,
  runEvents,
  runs,
  usageEvents,
} from "../db/schema.js";
import { resolveNextHop } from "./resolve.js";
import { withNodeTimeout } from "./circuitBreaker.js";
import { withRetry } from "./retry.js";
import { getCredentials } from "./credentials.js";
import { classifyProviderError } from "./providerErrors.js";
import { computeWarnings } from "./warnings.js";
import { enqueueHop } from "../queue/runQueue.js";
import { publishRunEvent } from "../ws/publish.js";

interface AgentCallResult {
  text: string;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Dispatches exactly one hop for a run, then either enqueues the next hop
 * or completes the run. This is the whole orchestration engine: there is no
 * function that "plans a run" up front. Routing is resolved fresh on every
 * call to resolveNextHop, which is what lets a canvas edit change a live
 * run's path without ever cancelling an in-flight model call.
 *
 * Each hop also runs behind its own timeout (circuitBreaker.ts) and as its
 * own BullMQ job, so one hung node fails only its own run — it can't stall
 * sibling nodes or other runs sharing the same worker pool. The one
 * exception is a consensus fan-out (see dispatchConsensus below), where
 * branches run concurrently within a single job by design.
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

  let result: AgentCallResult;
  try {
    result = await withNodeTimeout(node.id, () => callAgent(node, run.input));
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

  await recordUsage(runId, node.id, result);
  const output = result.text;

  // A consensus source node bypasses normal routing: fan out to every
  // branch concurrently, join, then continue from the aggregator.
  if (node.consensusGroup) {
    await db.insert(runEvents).values({
      runId,
      nodeId: node.id,
      sequence,
      status: "succeeded",
      input: run.input,
      output,
      startedAt,
      finishedAt: new Date(),
    });
    publishRunEvent({ runId, type: "hop_succeeded", nodeId: node.id, payload: { output } });
    await dispatchConsensus(runId, graph, node, output);
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

/**
 * Fan out to every branch in `node.consensusGroup` concurrently with the
 * same input, wait for all of them, then dispatch the aggregator with every
 * branch's output. Runs inline within the current job rather than as
 * separate queued hops — a deliberate v1 simplification (see
 * docs/orchestration.md) that trades per-branch job isolation for a much
 * simpler join. Each branch still has its own timeout, and one branch's
 * rejection doesn't cancel its siblings (Promise.allSettled).
 *
 * v1 has no partial-failure tolerance: any branch failing fails the whole
 * batch and the run, rather than letting the aggregator judge on a subset.
 */
async function dispatchConsensus(
  runId: string,
  graph: AgentGraph,
  sourceNode: AgentNode,
  input: unknown,
): Promise<void> {
  const group = sourceNode.consensusGroup!;
  const branches = group.edgeIds.map((edgeId) => {
    const edge = graph.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error(`Consensus edge ${edgeId} not found in graph ${graph.id}`);
    const targetNode = graph.nodes.find((n) => n.id === edge.targetNodeId);
    if (!targetNode) throw new Error(`Consensus target ${edge.targetNodeId} not found`);
    return { edge, targetNode };
  });

  const [batch] = await db
    .insert(fanoutBatches)
    .values({
      runId,
      aggregatorNodeId: group.aggregatorNodeId,
      totalBranches: branches.length,
      status: "pending",
    })
    .returning();

  const baseSequence = await nextSequence(runId);

  const settled = await Promise.allSettled(
    branches.map(async ({ edge, targetNode }, index) => {
      const sequence = baseSequence + index;
      const startedAt = new Date();
      publishRunEvent({ runId, type: "hop_dispatched", nodeId: targetNode.id });

      try {
        const result = await withNodeTimeout(targetNode.id, () => callAgent(targetNode, input));
        await recordUsage(runId, targetNode.id, result);
        await db.insert(runEvents).values({
          runId,
          nodeId: targetNode.id,
          sequence,
          status: "succeeded",
          resolvedEdgeId: edge.id,
          fanoutBatchId: batch.id,
          input,
          output: result.text,
          startedAt,
          finishedAt: new Date(),
        });
        publishRunEvent({ runId, type: "hop_succeeded", nodeId: targetNode.id, payload: { output: result.text } });
        return { nodeId: targetNode.id, output: result.text };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await db.insert(runEvents).values({
          runId,
          nodeId: targetNode.id,
          sequence,
          status: "failed",
          resolvedEdgeId: edge.id,
          fanoutBatchId: batch.id,
          input,
          error,
          startedAt,
          finishedAt: new Date(),
        });
        publishRunEvent({ runId, type: "hop_failed", nodeId: targetNode.id, payload: { error } });
        throw err;
      }
    }),
  );

  const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    await db.update(fanoutBatches).set({ status: "error" }).where(eq(fanoutBatches.id, batch.id));
    await db.update(runs).set({ status: "error", updatedAt: new Date() }).where(eq(runs.id, runId));
    publishRunEvent({
      runId,
      type: "hop_failed",
      nodeId: sourceNode.id,
      payload: { error: `${failures.length}/${branches.length} consensus branches failed` },
    });
    return;
  }

  const branchOutputs = (settled as PromiseFulfilledResult<{ nodeId: string; output: string }>[]).map(
    (r) => r.value,
  );

  await db
    .update(fanoutBatches)
    .set({ completedBranches: branches.length, status: "completed" })
    .where(eq(fanoutBatches.id, batch.id));

  await db
    .update(runs)
    .set({ currentNodeId: group.aggregatorNodeId, input: branchOutputs, updatedAt: new Date() })
    .where(eq(runs.id, runId));
  await enqueueHop(runId);
}

async function recordUsage(runId: string, nodeId: string, result: AgentCallResult): Promise<void> {
  await db.insert(usageEvents).values({
    runId,
    nodeId,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: estimateCostUsd(result.provider, result.model, result.inputTokens, result.outputTokens),
  });
}

/**
 * Tries node.provider/node.model first, then each entry in
 * node.fallbackChain in order — but only on a classified auth or
 * model-not-found error (classifyProviderError). Any other error (e.g. a
 * genuine bad-request from malformed input) rethrows immediately, since
 * retrying the same input against a different provider won't help. See
 * docs/adapters.md.
 */
async function callAgent(node: AgentNode, input: unknown): Promise<AgentCallResult> {
  const targets = [{ provider: node.provider, model: node.model }, ...node.fallbackChain];
  const prompt = typeof input === "string" ? input : JSON.stringify(input);

  let lastError: unknown;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      const credentials = await getCredentials(node.graphId, node.id, target.provider);
      const model = getModel(target.provider, target.model, credentials);
      const tools =
        node.tools.length > 0 ? resolveTools(node.tools, { fileAccessRoot: node.fileAccessRoot }) : undefined;
      const result = await withRetry(() =>
        generateText({
          model,
          system: node.systemPrompt,
          prompt,
          ...(tools ? { tools, stopWhen: stepCountIs(5) } : {}),
        }),
      );
      return {
        text: result.text,
        provider: target.provider,
        model: target.model,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      };
    } catch (err) {
      lastError = err;
      const isLastTarget = i === targets.length - 1;
      const errorClass = classifyProviderError(err);
      if (isLastTarget || (errorClass !== "auth" && errorClass !== "model")) {
        throw err;
      }
      // else: fall through to the next target in the chain
    }
  }
  throw lastError;
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

/**
 * The one place a raw agent_nodes row becomes an AgentNode — every route
 * that returns a node (creation, quick-add, graph reads) must go through
 * this, not `.returning()`'s raw row directly. The DB stores position as
 * flat positionX/positionY columns; AgentNode needs it nested as
 * `position: {x, y}`. Skipping this mapping is exactly what caused a
 * `t.position is undefined` crash in the canvas after adding a node — the
 * create-node response was the unmapped raw row.
 */
export function nodeRowToAgentNode(n: typeof agentNodes.$inferSelect): AgentNode {
  return {
    id: n.id,
    graphId: n.graphId,
    name: n.name,
    role: n.role as AgentNode["role"],
    provider: n.provider as AgentNode["provider"],
    model: n.model,
    tier: (n.tier as AgentNode["tier"]) ?? undefined,
    systemPrompt: n.systemPrompt,
    description: n.description,
    tools: n.tools as string[],
    fileAccessRoot: n.fileAccessRoot ?? undefined,
    fallbackChain: n.fallbackChain as AgentNode["fallbackChain"],
    consensusGroup: (n.consensusGroup as AgentNode["consensusGroup"]) ?? undefined,
    position: { x: n.positionX, y: n.positionY },
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

/** Reads the current graph straight from Postgres — used by "live" runs and the graph-detail API. */
export async function loadLiveGraph(graphId: string): Promise<AgentGraph> {
  const graphRow = await db.query.agentGraphs.findFirst({ where: eq(agentGraphs.id, graphId) });
  if (!graphRow) throw new Error(`Graph ${graphId} not found`);

  const nodes = await db.select().from(agentNodes).where(eq(agentNodes.graphId, graphId));
  const edges = await db.select().from(routingEdges).where(eq(routingEdges.graphId, graphId));

  const graph: AgentGraph = {
    id: graphRow.id,
    name: graphRow.name,
    description: graphRow.description,
    ownerId: graphRow.ownerId,
    entryNodeId: graphRow.entryNodeId,
    version: graphRow.version,
    warnings: [],
    createdAt: graphRow.createdAt.toISOString(),
    updatedAt: graphRow.updatedAt.toISOString(),
    nodes: nodes.map(nodeRowToAgentNode),
    edges: edges.map((e) => ({
      id: e.id,
      graphId: e.graphId,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      kind: e.kind as "explicit" | "auto" | "consensus",
      condition: e.condition as AgentGraph["edges"][number]["condition"],
      priority: e.priority,
      label: e.label ?? undefined,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
  };

  graph.warnings = computeWarnings(graph);
  return graph;
}
