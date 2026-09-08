"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
  createNodeFromExisting,
  createRun,
  createTemplate,
  listAllAgents,
  quickAddAgent,
  rerouteEdge,
  updateGraph,
} from "../lib/api";
import { useRunEventsSocket } from "../lib/useRunEventsSocket";
import { AgentConversationPanel } from "./AgentConversationPanel";
import { SignalEdge, type EdgePulse } from "./SignalEdge";
import { useTheme } from "./ThemeProvider";

const EDGE_TYPES = { signal: SignalEdge };

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
    type: "signal",
  }));
}

export const PROVIDERS: ProviderId[] = ["anthropic", "openai", "xai", "openrouter", "openai-compatible"];
export const ROLES: AgentNode["role"][] = ["supervisor", "worker", "router", "reviewer"];

function groupByGraph<T extends { graphName: string }>(agents: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const agent of agents) {
    const list = groups.get(agent.graphName) ?? [];
    list.push(agent);
    groups.set(agent.graphName, list);
  }
  return [...groups.entries()];
}

/**
 * Dragging an existing edge's endpoint to a new node calls the reroute API
 * immediately, but that's it — it never reaches into a running orchestration
 * loop. A live run picks up the change on its next hop because the engine
 * re-resolves routing from the current graph before every dispatch (see
 * apps/api/src/orchestrator/resolve.ts). Dragging from a node's handle to a
 * new node creates a fresh explicit edge instead.
 */
export function HierarchyCanvas({
  graph: initialGraph,
  showStartRunButton = true,
}: {
  graph: AgentGraph;
  /** Off in embedded contexts (HierarchyChat) that already provide a real chat input with conversation memory and inline results — this toolbar button uses a raw window.prompt() with neither. Stays on for the standalone /hierarchy editor, which has no chat strip alternative. */
  showStartRunButton?: boolean;
}) {
  const { theme } = useTheme();
  const [graph, setGraph] = useState(initialGraph);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(initialGraph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(initialGraph));
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addMode, setAddMode] = useState<"quick" | "manual" | "existing">("quick");
  const [quickDescription, setQuickDescription] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [connectFrom, setConnectFrom] = useState("");
  const [existingAgents, setExistingAgents] = useState<(AgentNode & { graphName: string })[] | null>(null);
  const [existingAgentId, setExistingAgentId] = useState("");
  const [existingBusy, setExistingBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    role: "worker" as AgentNode["role"],
    provider: "anthropic" as ProviderId,
    model: "claude-sonnet-5",
    systemPrompt: "",
    description: "",
    fileAccessRoot: "",
  });

  const [pulses, setPulses] = useState<EdgePulse[]>([]);
  const nodeClearTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * React won't restart a CSS animation just because the same className is
   * reapplied (e.g. a node visited twice in one run) — clearing to "" and
   * reapplying on the next frame forces a real DOM attribute change each
   * time. Per-node clear timers mean a fresh event on a re-visited node
   * cancels any stale pending fade-out from its previous visit.
   */
  const setNodeStatus = useCallback(
    (nodeId: string, cls: string, autoClearMs?: number) => {
      clearTimeout(nodeClearTimers.current.get(nodeId));
      nodeClearTimers.current.delete(nodeId);
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, className: "" } : n)));
      requestAnimationFrame(() => {
        setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, className: cls } : n)));
        if (autoClearMs) {
          const t = setTimeout(() => {
            setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, className: "" } : n)));
            nodeClearTimers.current.delete(nodeId);
          }, autoClearMs);
          nodeClearTimers.current.set(nodeId, t);
        }
      });
    },
    [setNodes],
  );

  const addPulse = useCallback((edgeId: string) => {
    const id = `${edgeId}-${Date.now()}-${Math.random()}`;
    setPulses((ps) => [...ps, { id, edgeId }]);
    setTimeout(() => setPulses((ps) => ps.filter((p) => p.id !== id)), 650);
  }, []);

  useRunEventsSocket(graph.id, (msg) => {
    if (msg.nodeId) {
      if (msg.type === "hop_dispatched") setNodeStatus(msg.nodeId, "node-running");
      else if (msg.type === "hop_succeeded") setNodeStatus(msg.nodeId, "node-succeeded", 2000);
      else if (msg.type === "hop_failed") setNodeStatus(msg.nodeId, "node-failed", 4000);
    }
    if (msg.type === "hop_succeeded" && msg.resolvedEdgeId) {
      addPulse(msg.resolvedEdgeId);
    }
  });

  const edgesWithPulses = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: { pulses: pulses.filter((p) => p.edgeId === e.id) },
      })),
    [edges, pulses],
  );

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

  /** Lazy-loads the cross-graph agent roster the first time "Existing agent" is selected. */
  function selectAddMode(mode: "quick" | "manual" | "existing") {
    setAddMode(mode);
    if (mode === "existing" && existingAgents === null) {
      listAllAgents()
        .then(setExistingAgents)
        .catch((err) => {
          console.error("Failed to load agents:", err);
          setExistingAgents([]);
        });
    }
  }

  /** Copies an already-configured agent from another graph in, via POST .../nodes/from-existing. */
  async function addExisting() {
    if (!existingAgentId) return;
    setExistingBusy(true);
    try {
      const position = connectFrom ? positionBelow(connectFrom) : { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };
      const node = await createNodeFromExisting(graph.id, { sourceNodeId: existingAgentId, position });
      appendNode(node);
      await connectIfRequested(node);
      setExistingAgentId("");
      setShowAddAgent(false);
    } catch (err) {
      console.error("Add existing agent failed:", err);
      window.alert(err instanceof Error ? err.message : "Failed to add existing agent");
    } finally {
      setExistingBusy(false);
    }
  }

  async function setEntry(nodeId: string) {
    const updated = await updateGraph(graph.id, { entryNodeId: nodeId });
    setGraph((g) => ({ ...g, entryNodeId: updated.entryNodeId }));
  }

  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [openAgentPanel, setOpenAgentPanel] = useState<string | null>(null);
  const openAgentNode = openAgentPanel ? graph.nodes.find((n) => n.id === openAgentPanel) ?? null : null;

  /** Keeps both graph state (source of truth for settings) and the canvas label in sync after an edit. */
  function handleNodeUpdated(updated: AgentNode) {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === updated.id ? updated : n)) }));
    setNodes((nds) =>
      nds.map((n) =>
        n.id === updated.id
          ? { ...n, data: { label: `${ROLE_ICON[updated.role] ?? ""}${updated.name}\n${updated.provider}:${updated.model}` } }
          : n,
      ),
    );
  }

  /** Stays on the canvas to watch the live pulse instead of navigating away — the whole point of the animation is seeing it happen here. */
  async function startRun() {
    const input = window.prompt("Run input:");
    if (!input) return;
    const run = await createRun(graph.id, input);
    setLastRunId(run.id);
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
        {showStartRunButton && (
          <button onClick={startRun} disabled={!graph.entryNodeId}>
            ▶ Start run
          </button>
        )}
        <button onClick={saveAsTemplate}>Save as template</button>
        <a href={`/runs?graphId=${graph.id}`}>View runs</a>
        {showStartRunButton && lastRunId && <a href={`/runs/${lastRunId}`}>Run started — view full trail →</a>}
      </div>

      {showAddAgent && (
        <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 12, marginBottom: 8, alignItems: "center" }}>
            <label>
              <input type="radio" checked={addMode === "quick"} onChange={() => selectAddMode("quick")} /> Describe it
            </label>
            <label>
              <input type="radio" checked={addMode === "manual"} onChange={() => selectAddMode("manual")} /> Manual
            </label>
            <label>
              <input type="radio" checked={addMode === "existing"} onChange={() => selectAddMode("existing")} /> Existing agent
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

          {addMode === "existing" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select value={existingAgentId} onChange={(e) => setExistingAgentId(e.target.value)} style={{ flex: 1, minWidth: 260 }}>
                  <option value="">{existingAgents === null ? "Loading…" : "Select an agent…"}</option>
                  {groupByGraph(existingAgents ?? []).map(([graphName, agents]) => (
                    <optgroup key={graphName} label={graphName}>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button onClick={addExisting} disabled={!existingAgentId || existingBusy}>
                  {existingBusy ? "Adding…" : "Add"}
                </button>
              </div>
              {existingAgents?.length === 0 && (
                <p style={{ color: "var(--text-faint)", margin: 0 }}>No other agents found — describe one or add it manually instead.</p>
              )}
              {(() => {
                const selected = existingAgents?.find((a) => a.id === existingAgentId);
                if (!selected?.fileAccessRoot) return null;
                return (
                  <p style={{ color: "var(--text-faint)", margin: 0, fontSize: 13 }}>
                    This agent has file access to <code>{selected.fileAccessRoot}</code> — that access will be copied to the new agent too.
                  </p>
                );
              })()}
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1, position: "relative" }}>
        <ReactFlow
          nodes={nodes}
          edges={edgesWithPulses}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onReconnect={onReconnect}
          onConnect={onConnect}
          onNodeClick={(_, node) => setOpenAgentPanel(node.id)}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {openAgentNode && (
          <AgentConversationPanel
            graphId={graph.id}
            node={openAgentNode}
            onClose={() => setOpenAgentPanel(null)}
            onNodeUpdated={handleNodeUpdated}
          />
        )}
      </div>
    </div>
  );
}
