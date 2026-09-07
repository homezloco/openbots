"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  reconnectEdge,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentGraph, AgentNode, ProviderId } from "@openbots/graph-schema";
import {
  createEdge,
  createNode,
  createRun,
  createTemplate,
  quickAddAgent,
  rerouteEdge,
  runEventsSocketUrl,
  updateGraph,
} from "../lib/api";
import { useTheme } from "./ThemeProvider";

const ROLE_ICON: Partial<Record<AgentNode["role"], string>> = { supervisor: "👑 ", reviewer: "🔎 " };

function toFlowNodes(graph: AgentGraph): Node[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: { label: `${ROLE_ICON[n.role] ?? ""}${n.name}\n${n.provider}:${n.model}` },
  }));
}

function edgeStyle(kind: AgentGraph["edges"][number]["kind"]): React.CSSProperties | undefined {
  if (kind === "auto") return { strokeDasharray: "4 4" };
  if (kind === "consensus") return { strokeDasharray: "1 4", stroke: "var(--consensus-edge)" };
  return undefined;
}

function toFlowEdges(graph: AgentGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label,
    style: edgeStyle(e.kind),
  }));
}

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "xai", "openrouter", "openai-compatible"];
const ROLES: AgentNode["role"][] = ["supervisor", "worker", "router", "reviewer"];

/**
 * Dragging an existing edge's endpoint to a new node calls the reroute API
 * immediately, but that's it — it never reaches into a running orchestration
 * loop. A live run picks up the change on its next hop because the engine
 * re-resolves routing from the current graph before every dispatch (see
 * apps/api/src/orchestrator/resolve.ts). Dragging from a node's handle to a
 * new node creates a fresh explicit edge instead.
 */
export function HierarchyCanvas({ graph: initialGraph }: { graph: AgentGraph }) {
  const { theme } = useTheme();
  const [graph, setGraph] = useState(initialGraph);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(initialGraph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(initialGraph));
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addMode, setAddMode] = useState<"quick" | "manual">("quick");
  const [quickDescription, setQuickDescription] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [connectFrom, setConnectFrom] = useState("");
  const [form, setForm] = useState({
    name: "",
    role: "worker" as AgentNode["role"],
    provider: "anthropic" as ProviderId,
    model: "claude-sonnet-5",
    systemPrompt: "",
    description: "",
    fileAccessRoot: "",
  });

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

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      createEdge(graph.id, { sourceNodeId: connection.source, targetNodeId: connection.target, kind: "explicit" })
        .then((edge) => {
          setEdges((eds) => addEdge({ ...connection, id: edge.id, style: edgeStyle(edge.kind) }, eds));
        })
        .catch((err) => console.error("Failed to create edge:", err));
    },
    [graph.id, setEdges],
  );

  function appendNode(node: AgentNode) {
    setNodes((nds) => [
      ...nds,
      { id: node.id, position: node.position, data: { label: `${ROLE_ICON[node.role] ?? ""}${node.name}\n${node.provider}:${node.model}` } },
    ]);
  }

  /** Positions a new node below its chosen source, fanned out horizontally so multiple children don't stack on top of each other. */
  function positionBelow(sourceId: string): { x: number; y: number } {
    const source = nodes.find((n) => n.id === sourceId);
    if (!source) return { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };
    const siblingCount = edges.filter((e) => e.source === sourceId).length;
    return { x: source.position.x + siblingCount * 220, y: source.position.y + 180 };
  }

  /** If a "connects from" source is selected, wires the new node underneath it with an explicit edge. */
  async function connectIfRequested(newNode: AgentNode) {
    if (!connectFrom) return;
    const edge = await createEdge(graph.id, { sourceNodeId: connectFrom, targetNodeId: newNode.id, kind: "explicit" });
    setEdges((eds) => [...eds, { id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: edgeStyle(edge.kind) }]);
  }

  async function addAgent() {
    if (!form.name.trim()) return;
    const position = connectFrom ? positionBelow(connectFrom) : { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };
    const node = await createNode(graph.id, {
      ...form,
      fileAccessRoot: form.fileAccessRoot || undefined,
      tools: form.fileAccessRoot ? ["read_file", "list_directory"] : [],
      position,
    });
    appendNode(node);
    await connectIfRequested(node);
    setShowAddAgent(false);
    setForm({ ...form, name: "", systemPrompt: "", description: "", fileAccessRoot: "" });
  }

  /** The "master agent" flow: describe the agent, an LLM fills in the rest, then it's created through the same API as the manual form. */
  async function quickAdd() {
    if (!quickDescription.trim()) return;
    setQuickBusy(true);
    try {
      const position = connectFrom ? positionBelow(connectFrom) : undefined;
      const node = await quickAddAgent(graph.id, { description: quickDescription, position });
      appendNode(node);
      await connectIfRequested(node);
      setQuickDescription("");
      setShowAddAgent(false);
    } catch (err) {
      console.error("Quick-add failed:", err);
      window.alert(err instanceof Error ? err.message : "Quick-add failed");
    } finally {
      setQuickBusy(false);
    }
  }

  async function setEntry(nodeId: string) {
    const updated = await updateGraph(graph.id, { entryNodeId: nodeId });
    setGraph((g) => ({ ...g, entryNodeId: updated.entryNodeId }));
  }

  async function startRun() {
    const input = window.prompt("Run input:");
    if (!input) return;
    const run = await createRun(graph.id, input);
    window.location.href = `/runs/${run.id}`;
  }

  async function saveAsTemplate() {
    const name = window.prompt("Template name:");
    if (!name) return;
    await createTemplate(graph.id, name);
    window.alert("Saved as template.");
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {graph.warnings.length > 0 && (
        <div style={{ background: "var(--warning-bg)", borderBottom: "1px solid var(--warning-border)", padding: 8, fontSize: 13 }}>
          {graph.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <button onClick={() => setShowAddAgent((s) => !s)}>+ Add agent</button>
        <label>
          Entry:
          <select value={graph.entryNodeId ?? ""} onChange={(e) => setEntry(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="" disabled>
              Select…
            </option>
            {graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={startRun} disabled={!graph.entryNodeId}>
          ▶ Start run
        </button>
        <button onClick={saveAsTemplate}>Save as template</button>
        <a href={`/runs?graphId=${graph.id}`}>View runs</a>
      </div>

      {showAddAgent && (
        <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 12, marginBottom: 8, alignItems: "center" }}>
            <label>
              <input type="radio" checked={addMode === "quick"} onChange={() => setAddMode("quick")} /> Describe it
            </label>
            <label>
              <input type="radio" checked={addMode === "manual"} onChange={() => setAddMode("manual")} /> Manual
            </label>
            <label>
              Connects from:
              <select value={connectFrom} onChange={(e) => setConnectFrom(e.target.value)} style={{ marginLeft: 4 }}>
                <option value="">(none — unconnected)</option>
                {graph.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {addMode === "quick" && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder='e.g. "Reviews pull request diffs for security issues"'
                value={quickDescription}
                onChange={(e) => setQuickDescription(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && quickAdd()}
                style={{ flex: 1 }}
              />
              <button onClick={quickAdd} disabled={quickBusy}>
                {quickBusy ? "Thinking…" : "Add"}
              </button>
            </div>
          )}

          {addMode === "manual" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AgentNode["role"] })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderId })}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input placeholder="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              <input
                placeholder="Description (used for auto-routing)"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                style={{ flex: 1, minWidth: 200 }}
              />
              <input
                placeholder="System prompt"
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                style={{ flex: 1, minWidth: 200 }}
              />
              <input
                placeholder="File access root (optional, absolute path, read-only)"
                value={form.fileAccessRoot}
                onChange={(e) => setForm({ ...form, fileAccessRoot: e.target.value })}
                style={{ flex: 1, minWidth: 260 }}
              />
              <button onClick={addAgent}>Add</button>
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onReconnect={onReconnect}
          onConnect={onConnect}
          colorMode={theme}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
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
