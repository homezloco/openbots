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
// @ts-ignore — no type declarations for CSS side-effect import
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
import { SchedulesPanel } from "./SchedulesPanel";
import { GitHubPanel } from "./GitHubPanel";
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
  const edges = graph.edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label,
    style: edgeStyle(e.kind),
    type: "signal",
  })) as Edge[];

  // A consensus fan-out has a hidden-in-data but visible-in-UI "gather" edge
  // from the source to the aggregator. This makes the join visible and gives
  // the SignalEdge a path to animate when all branches complete.
  for (const n of graph.nodes) {
    if (n.consensusGroup) {
      const id = `consensus-gather-${n.id}-${n.consensusGroup.aggregatorNodeId}`;
      edges.push({
        id,
        source: n.id,
        target: n.consensusGroup.aggregatorNodeId,
        style: { strokeDasharray: "3 3", stroke: "var(--consensus-edge)", opacity: 0.75 },
        type: "signal",
        data: { isConsensusGather: true },
        selectable: false,
        deletable: false,
      });
    }
  }

  return edges;
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
    allowWrites: true,
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

  const addPulse = useCallback((edgeId: string, color?: string) => {
    const id = `${edgeId}-${Date.now()}-${Math.random()}`;
    setPulses((ps) => [...ps, { id, edgeId, color }]);
    setTimeout(() => setPulses((ps) => ps.filter((p) => p.id !== id)), 650);
  }, []);

  // consensus source -> aggregator, used for the gather pulse animation.
  const consensusGatherByAggregator = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.consensusGroup) {
        map.set(n.consensusGroup.aggregatorNodeId, `consensus-gather-${n.id}-${n.consensusGroup.aggregatorNodeId}`);
      }
    }
    return map;
  }, [graph]);

  useRunEventsSocket(graph.id, (msg) => {
    if (msg.nodeId) {
      if (msg.type === "hop_dispatched") setNodeStatus(msg.nodeId, "node-running");
      else if (msg.type === "hop_succeeded") setNodeStatus(msg.nodeId, "node-succeeded", 2000);
      else if (msg.type === "hop_failed") setNodeStatus(msg.nodeId, "node-failed", 4000);
    }
    if (msg.type === "hop_succeeded" && msg.resolvedEdgeId) {
      // Green pulse for a completed hop "communicating" its result to the next node.
      addPulse(msg.resolvedEdgeId, "var(--status-succeeded)");
    }
    if (msg.type === "hop_dispatched" && msg.nodeId && consensusGatherByAggregator.has(msg.nodeId)) {
      // All branches are done and the aggregator is being dispatched —
      // animate the gather from the fan-out source down into the aggregator.
      addPulse(consensusGatherByAggregator.get(msg.nodeId)!, "var(--consensus-edge)");
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
      // The consensus gather edges are synthetic UI-only edges; they cannot be
      // rerouted or persisted.
      if ((oldEdge.data as { isConsensusGather?: boolean } | undefined)?.isConsensusGather) return;
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
    const { allowWrites, ...rest } = form;
    const node = await createNode(graph.id, {
      ...rest,
      fileAccessRoot: form.fileAccessRoot || undefined,
      tools: form.fileAccessRoot
        ? ["read_file", "list_directory", ...(allowWrites ? ["write_file", "edit_file"] : [])]
        : [],
      position,
    });
    appendNode(node);
    await connectIfRequested(node);
    setShowAddAgent(false);
    setForm({ ...form, name: "", systemPrompt: "", description: "", fileAccessRoot: "", allowWrites: true });
  }

  /** The "master agent" flow: describe the agent, an LLM fills in the rest, then it's created through the same API as the manual form. */
  async function quickAdd() {
    if (!quickDescription.trim()) return;
    setQuickBusy(true);
    setQuickAddError(null);
    try {
      const position = connectFrom ? positionBelow(connectFrom) : undefined;
      const node = await quickAddAgent(graph.id, { description: quickDescription, position });
      appendNode(node);
      await connectIfRequested(node);
      setQuickDescription("");
      setShowAddAgent(false);
    } catch (err) {
      console.error("Quick-add failed:", err);
      setQuickAddError(err instanceof Error ? err.message : "Quick-add failed");
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
    setExistingError(null);
    try {
      const position = connectFrom ? positionBelow(connectFrom) : { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 };
      const node = await createNodeFromExisting(graph.id, { sourceNodeId: existingAgentId, position });
      appendNode(node);
      await connectIfRequested(node);
      setExistingAgentId("");
      setShowAddAgent(false);
    } catch (err) {
      console.error("Add existing agent failed:", err);
      setExistingError(err instanceof Error ? err.message : "Failed to add existing agent");
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
  const [showSchedules, setShowSchedules] = useState(false);
  const [showGitHub, setShowGitHub] = useState(false);
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [templateInputOpen, setTemplateInputOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const [existingError, setExistingError] = useState<string | null>(null);
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
    if (!runInput.trim() || !graph.entryNodeId) return;
    const run = await createRun(graph.id, runInput.trim());
    setLastRunId(run.id);
    setRunInput("");
    setRunInputOpen(false);
  }

  async function saveAsTemplate() {
    if (!templateName.trim()) return;
    await createTemplate(graph.id, templateName.trim());
    setTemplateName("");
    setTemplateInputOpen(false);
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
        {showStartRunButton &&
          (runInputOpen ? (
            <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                value={runInput}
                onChange={(e) => setRunInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startRun()}
                placeholder="What should the team do?"
                style={{ width: 260 }}
              />
              <button onClick={startRun} disabled={!runInput.trim() || !graph.entryNodeId}>
                Run
              </button>
              <button
                type="button"
                onClick={() => {
                  setRunInputOpen(false);
                  setRunInput("");
                }}
                style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setRunInputOpen(true)} disabled={!graph.entryNodeId}>
              ▶ Start run
            </button>
          ))}
        {templateInputOpen ? (
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveAsTemplate()}
              placeholder="Template name"
              style={{ width: 200 }}
            />
            <button onClick={saveAsTemplate} disabled={!templateName.trim()}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setTemplateInputOpen(false);
                setTemplateName("");
              }}
              style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button onClick={() => setTemplateInputOpen(true)}>Save as template</button>
        )}
        <button
          onClick={() => {
            setOpenAgentPanel(null);
            setShowGitHub(false);
            setShowSchedules((s) => !s);
          }}
        >
          ⏰ Schedules
        </button>
        <button
          onClick={() => {
            setOpenAgentPanel(null);
            setShowSchedules(false);
            setShowGitHub((s) => !s);
          }}
        >
          🐙 GitHub
        </button>
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
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
              {quickAddError && <p style={{ color: "var(--danger)", margin: 0, fontSize: 13 }}>{quickAddError}</p>}
            </div>
          )}

          {addMode === "manual" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Name</span>
                <input placeholder="e.g. Security reviewer" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Role</span>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AgentNode["role"] })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Provider</span>
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as ProviderId })}>
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Model</span>
                <input placeholder="claude-sonnet-5" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Description (used for auto-routing)</span>
                <input
                  placeholder="What this agent does, in one line"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>System prompt</span>
                <textarea
                  rows={3}
                  placeholder="Instructions for the agent"
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>File access root (optional, absolute path)</span>
                <input
                  placeholder="/path/to/project"
                  value={form.fileAccessRoot}
                  onChange={(e) => setForm({ ...form, fileAccessRoot: e.target.value })}
                />
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", gridColumn: "1 / -1", opacity: form.fileAccessRoot ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={form.allowWrites}
                  disabled={!form.fileAccessRoot}
                  onChange={(e) => setForm({ ...form, allowWrites: e.target.checked })}
                />
                <span style={{ fontSize: 13 }}>
                  Allow file writes <span style={{ color: "var(--text-faint)", fontSize: 12 }}>(isolated git branch; root must be in ALLOWED_FILE_WRITE_ROOTS)</span>
                </span>
              </label>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button onClick={addAgent}>Add agent</button>
              </div>
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
              {existingError && <p style={{ color: "var(--danger)", margin: 0, fontSize: 13 }}>{existingError}</p>}
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
          onNodeClick={(_, node) => {
            setShowSchedules(false);
            setShowGitHub(false);
            setOpenAgentPanel(node.id);
          }}
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
        {showSchedules && <SchedulesPanel graphId={graph.id} onClose={() => setShowSchedules(false)} />}
        {showGitHub && <GitHubPanel graphId={graph.id} onClose={() => setShowGitHub(false)} />}
      </div>
    </div>
  );
}
