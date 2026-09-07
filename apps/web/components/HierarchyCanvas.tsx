"use client";

import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  reconnectEdge,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentGraph } from "@openbots/graph-schema";
import { rerouteEdge, runEventsSocketUrl } from "../lib/api";

function toFlowNodes(graph: AgentGraph): Node[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: { label: `${n.name}\n${n.provider}:${n.model}` },
  }));
}

function toFlowEdges(graph: AgentGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label,
    // Auto edges render dashed: their target is resolved at runtime by
    // description matching, not hard-wired like explicit edges.
    style: e.kind === "auto" ? { strokeDasharray: "4 4" } : undefined,
  }));
}

/**
 * Dragging an edge's endpoint to a new node calls the reroute API
 * immediately, but that's it — it never reaches into a running orchestration
 * loop. A live run picks up the change on its next hop because the engine
 * re-resolves routing from the current graph before every dispatch (see
 * apps/api/src/orchestrator/resolve.ts).
 */
export function HierarchyCanvas({ graph }: { graph: AgentGraph }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(graph));

  useEffect(() => {
    const ws = new WebSocket(runEventsSocketUrl());
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as { nodeId?: string; type: string };
      if (!msg.nodeId) return;
      setNodes((nds) =>
        nds.map((n) => (n.id === msg.nodeId ? { ...n, className: statusClass(msg.type) } : n)),
      );
    };
    return () => ws.close();
  }, [setNodes]);

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
      if (newConnection.target) {
        rerouteEdge(graph.id, oldEdge.id, newConnection.target).catch((err) => {
          console.error("Failed to persist reroute:", err);
        });
      }
    },
    [graph.id, setEdges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onReconnect={onReconnect}
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

function statusClass(eventType: string): string {
  switch (eventType) {
    case "hop_dispatched":
      return "node-running";
    case "hop_succeeded":
      return "node-succeeded";
    case "hop_failed":
      return "node-failed";
    default:
      return "";
  }
}
