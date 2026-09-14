import { tool, type Tool } from "ai";
import { z } from "zod";
import { AgentRole, ModelTier, ProviderId } from "@openbots/graph-schema";
import { getDispatchableGraphs, type DispatchableGraph } from "./dispatchTool.js";
import { loadLiveGraph } from "./engine.js";
import {
  deleteAgentNode,
  deleteRoutingEdge,
  insertAgentNodeValidated,
  insertRoutingEdge,
  updateAgentNode,
} from "./graphMutations.js";

/**
 * The "full graph editing" half of supervisor control (see PLAN.md's
 * "Cross-graph supervisor control" section) — a much bigger capability
 * than dispatch_to_graph's fire-and-forget run start, so every tool here
 * re-verifies dispatchTargets ownership fresh on every call via
 * getDispatchableGraphs, exactly like dispatch_to_graph does, and every
 * mutation goes through the SAME validated functions
 * (graphMutations.ts::insertAgentNodeValidated/updateAgentNode/etc.) the
 * human-facing PATCH/POST routes use — a cross-graph edit is held to the
 * exact same write-root-allowlist and dispatch-ownership standard a human
 * editing the node directly through the canvas would be, not a
 * hand-rolled, separately-maintained subset of it.
 *
 * Deliberately NOT settable by any tool here: dispatchTargets (the actual
 * reachability boundary — keeping it human/PATCH-only means "which graphs
 * are in scope" can never be silently expanded from inside a dispatch),
 * consensusGroup (needs edge-id resolution by name to be usable from a
 * tool call at all; real complexity for no clear v1 use case), and
 * sshTarget (the actual grant boundary for run_remote_command, same
 * reasoning as dispatchTargets — `tools` here CAN already include
 * "run_remote_command", but that alone is inert without a human/PATCH-set
 * sshTarget on the same node, the same dual-gate that already lets `tools`
 * safely include "dispatch_to_graph" without dispatchTargets), and
 * mcpServers (remote token blast radius — human/PATCH-only, same as
 * dispatchTargets).
 */

async function resolveTargetGraph(
  ownerId: string | null,
  dispatchTargets: string[],
  targetGraphName: string,
): Promise<{ target: DispatchableGraph } | { error: string }> {
  const candidates = await getDispatchableGraphs(ownerId, dispatchTargets);
  const target = candidates.find((g) => g.name.trim().toLowerCase() === targetGraphName.trim().toLowerCase());
  if (!target) {
    const names = candidates.map((g) => g.name).join(", ") || "(none)";
    return { error: `No dispatchable graph named "${targetGraphName}". Valid targets: ${names}` };
  }
  return { target };
}

function findNodeByName<T extends { name: string }>(nodes: T[], name: string): T | undefined {
  return nodes.find((n) => n.name.trim().toLowerCase() === name.trim().toLowerCase());
}

const nodeFieldsSchema = {
  name: z.string().optional(),
  role: AgentRole.optional(),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  tier: ModelTier.optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  fileAccessRoot: z.string().optional().describe("Absolute path, subject to the operator's ALLOWED_FILE_ACCESS_ROOTS allowlist."),
  tools: z.array(z.string()).optional(),
};

export function createListTargetGraphTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "List the nodes and routing edges of one of your target graphs, before editing it.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
    }),
    execute: async ({ targetGraphName }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
      return {
        graph: resolved.target.name,
        nodes: graph.nodes.map((n) => ({
          name: n.name,
          role: n.role,
          tier: n.tier,
          provider: n.provider,
          model: n.model,
          description: n.description,
          systemPrompt: n.systemPrompt,
          fileAccessRoot: n.fileAccessRoot,
          tools: n.tools,
        })),
        edges: graph.edges.map((e) => ({
          source: nodesById.get(e.sourceNodeId)?.name ?? e.sourceNodeId,
          target: nodesById.get(e.targetNodeId)?.name ?? e.targetNodeId,
          kind: e.kind,
        })),
      };
    },
  });
}

export function createCreateTargetNodeTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "Create a new agent node in one of your target graphs.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      name: z.string(),
      role: AgentRole,
      provider: ProviderId,
      model: z.string(),
      description: z.string().optional(),
      systemPrompt: z.string().optional(),
      tier: ModelTier.optional(),
      fileAccessRoot: nodeFieldsSchema.fileAccessRoot,
      tools: nodeFieldsSchema.tools,
    }),
    execute: async ({ targetGraphName, ...fields }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const position = { x: 250, y: 100 + graph.nodes.length * 150 };
      const result = await insertAgentNodeValidated(resolved.target.id, { ...fields, position }, ownerId);
      if (!result.ok) return { error: result.error };
      return { created: result.value.name, graph: resolved.target.name };
    },
  });
}

export function createUpdateTargetNodeTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "Update an existing agent node in one of your target graphs.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      nodeName: z.string().describe("The exact current name of the node to update"),
      updates: z.object(nodeFieldsSchema),
    }),
    execute: async ({ targetGraphName, nodeName, updates }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const node = findNodeByName(graph.nodes, nodeName);
      if (!node) return { error: `No node named "${nodeName}" in "${resolved.target.name}".` };

      const result = await updateAgentNode(resolved.target.id, node.id, updates, ownerId);
      if (!result.ok) return { error: result.error };
      return { updated: result.value.name, graph: resolved.target.name };
    },
  });
}

export function createDeleteTargetNodeTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "Delete an agent node from one of your target graphs.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      nodeName: z.string().describe("The exact name of the node to delete"),
    }),
    execute: async ({ targetGraphName, nodeName }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const node = findNodeByName(graph.nodes, nodeName);
      if (!node) return { error: `No node named "${nodeName}" in "${resolved.target.name}".` };

      const result = await deleteAgentNode(resolved.target.id, node.id, ownerId);
      if (!result.ok) return { error: result.error };
      return { deleted: nodeName, graph: resolved.target.name };
    },
  });
}

export function createCreateTargetEdgeTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "Create a routing edge between two nodes in one of your target graphs.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      sourceNodeName: z.string(),
      targetNodeName: z.string(),
      kind: z.enum(["explicit", "auto", "consensus"]).optional(),
    }),
    execute: async ({ targetGraphName, sourceNodeName, targetNodeName, kind }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const source = findNodeByName(graph.nodes, sourceNodeName);
      const target = findNodeByName(graph.nodes, targetNodeName);
      if (!source) return { error: `No node named "${sourceNodeName}" in "${resolved.target.name}".` };
      if (!target) return { error: `No node named "${targetNodeName}" in "${resolved.target.name}".` };

      const result = await insertRoutingEdge(
        resolved.target.id,
        {
          sourceNodeId: source.id,
          targetNodeId: target.id,
          kind: kind ?? "explicit",
        },
        ownerId,
      );
      if (!result.ok) return { error: result.error };
      return { created: `${sourceNodeName} -> ${targetNodeName}`, kind: result.value.kind, graph: resolved.target.name };
    },
  });
}

export function createDeleteTargetEdgeTool(ownerId: string | null, dispatchTargets: string[]): Tool {
  return tool({
    description: "Delete the routing edge between two nodes in one of your target graphs.",
    inputSchema: z.object({
      targetGraphName: z.string().describe("The exact name of the target graph, from the list you were given"),
      sourceNodeName: z.string(),
      targetNodeName: z.string(),
    }),
    execute: async ({ targetGraphName, sourceNodeName, targetNodeName }) => {
      const resolved = await resolveTargetGraph(ownerId, dispatchTargets, targetGraphName);
      if ("error" in resolved) return resolved;

      const graph = await loadLiveGraph(resolved.target.id);
      const source = findNodeByName(graph.nodes, sourceNodeName);
      const target = findNodeByName(graph.nodes, targetNodeName);
      if (!source) return { error: `No node named "${sourceNodeName}" in "${resolved.target.name}".` };
      if (!target) return { error: `No node named "${targetNodeName}" in "${resolved.target.name}".` };

      const edge = graph.edges.find((e) => e.sourceNodeId === source.id && e.targetNodeId === target.id);
      if (!edge) return { error: `No edge from "${sourceNodeName}" to "${targetNodeName}" in "${resolved.target.name}".` };

      const result = await deleteRoutingEdge(resolved.target.id, edge.id, ownerId);
      if (!result.ok) return { error: result.error };
      return { deleted: `${sourceNodeName} -> ${targetNodeName}`, graph: resolved.target.name };
    },
  });
}
