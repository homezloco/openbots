"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  listGraphs,
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

const GATEWAY_NODE_PREFIX = "gateway:";
const GATEWAY_EDGE_PREFIX = "gateway-edge:";

/**
 * Every OTHER graph reachable from this one via dispatch_to_graph or
 * manage_target_graphs — a completely separate mechanism from
 * routing_edges (node.dispatchTargets, resolved at tool-call time), so
 * it's otherwise invisible on this canvas. Deduped by target graph id;
 * a graph pointing at itself (shouldn't happen, but harmless if it did)
 * is filtered out rather than rendering a self-loop.
 */
function getGatewayTargetIds(graph: AgentGraph): string[] {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    const wantsReach = n.tools.includes("dispatch_to_graph") || n.tools.includes("manage_target_graphs");
    if (!wantsReach) continue;
    for (const targetId of n.dispatchTargets ?? []) {
      if (targetId !== graph.id) ids.add(targetId);
    }
  }
  return [...ids];
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
  const router = useRouter();
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

  // Cross-graph reach (dispatch_to_graph/manage_target_graphs) is invisible
  // otherwise — it's node.dispatchTargets, a completely separate mechanism
  // from routing_edges. Strips and re-adds its own gateway:/gateway-edge:
  // -prefixed entries each time rather than diffing, mirroring toFlowEdges'
  // consensus-gather recompute-fresh approach. Pulled out of the effect
  // below so the "Reset layout" button can also call it directly, right
  // after restoring nodes/edges to their base (DB) positions.
  const applyGatewayNodes = useCallback(() => {
    const targetIds = getGatewayTargetIds(graph);
    if (targetIds.length === 0) {
      setNodes((nds) => nds.filter((n) => !n.id.startsWith(GATEWAY_NODE_PREFIX)));
      setEdges((eds) => eds.filter((e) => !e.id.startsWith(GATEWAY_EDGE_PREFIX)));
      return;
    }

    listGraphs().then((graphs) => {
      const targets = graphs.filter((g) => targetIds.includes(g.id));
      // Kept close to the real nodes (not maxY + a large offset) — long
      // dashed edges down to a far-away gateway row were reported as hard
      // to follow visually.
      const maxExistingY = Math.max(0, ...graph.nodes.map((n) => n.position.y));

      const gatewayNodes: Node[] = targets.map((t, i) => ({
        id: `${GATEWAY_NODE_PREFIX}${t.id}`,
        position: { x: i * 220, y: maxExistingY + 140 },
        data: { label: `🔗 ${t.name}`, isGateway: true, targetGraphId: t.id },
        style: { border: "2px dashed var(--text-faint)", opacity: 0.85 },
        connectable: false,
      }));

      const gatewayEdges: Edge[] = [];
      for (const n of graph.nodes) {
        const wantsReach = n.tools.includes("dispatch_to_graph") || n.tools.includes("manage_target_graphs");
        if (!wantsReach) continue;
        for (const targetId of n.dispatchTargets ?? []) {
          if (!targetIds.includes(targetId)) continue;
          gatewayEdges.push({
            id: `${GATEWAY_EDGE_PREFIX}${n.id}-${targetId}`,
            source: n.id,
            target: `${GATEWAY_NODE_PREFIX}${targetId}`,
            type: "signal",
            style: { strokeDasharray: "2 6", stroke: "var(--text-faint)" },
            selectable: false,
            deletable: false,
            data: { isGatewayEdge: true },
          } as Edge);
        }
      }

      setNodes((nds) => [...nds.filter((n) => !n.id.startsWith(GATEWAY_NODE_PREFIX)), ...gatewayNodes]);
      setEdges((eds) => [...eds.filter((e) => !e.id.startsWith(GATEWAY_EDGE_PREFIX)), ...gatewayEdges]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Re-runs whenever a node's dispatch config changes (e.g. after a
  // Settings save), so gateways stay live without a reload.
  useEffect(() => {
    applyGatewayNodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, graph.id]);

  /**
   * Node positions aren't persisted anywhere today (dragging is purely
   * local view state), so a rearrangement that gets confusing — nodes
   * dragged far apart, long/crossed edges — has no way back except
   * reloading the page. This snaps nodes/edges back to their real (DB)
   * positions plus a freshly recomputed gateway row, and remounts
   * <ReactFlow> (via resetCounter as its key) so the one-shot `fitView`
   * prop re-fits the viewport too.
   */
  const [resetCounter, setResetCounter] = useState(0);
  const resetLayout = useCallback(() => {
    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
    applyGatewayNodes();
    setResetCounter((c) => c + 1);
  }, [graph, applyGatewayNodes, setNodes, setEdges]);

  // Generous but bounded — keeps a dragged node from ending up far off in
  // empty canvas space (reported as "pushing" the rest of the diagram out
  // of view) while still leaving real room to rearrange. Scales with the
  // graph's own footprint rather than a fixed box so a bigger team isn't
  // cramped.
  const nodeExtent = useMemo((): [[number, number], [number, number]] => {
    const xs = graph.nodes.map((n) => n.position.x);
    const ys = graph.nodes.map((n) => n.position.y);
    const minX = Math.min(0, ...xs) - 400;
    const minY = Math.min(0, ...ys) - 400;
    const maxX = Math.max(600, ...xs) + 800;
    const maxY = Math.max(600, ...ys) + 1000;
    return [
      [minX, minY],
      [maxX, maxY],
    ];
  }, [graph.nodes]);

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
      // The consensus gather and cross-graph gateway edges are synthetic,
      // UI-only edges with no backing routing_edges row; they cannot be
      // rerouted or persisted. Checked by id prefix, not oldEdge.data —
      // the edges prop ReactFlow actually sees (edgesWithPulses below)
      // overwrites .data with { pulses } on every render, so a data-based
      // check here would never see isConsensusGather/isGatewayEdge.
      if ((oldEdge.data as { isConsensusGather?: boolean } | undefined)?.isConsensusGather) return;
      if (oldEdge.id.startsWith(GATEWAY_EDGE_PREFIX)) return;
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
  // Defaults on: this canvas is the interactive "watch it happen" view, and
  // dragging an edge to reroute is invisible unless the run re-resolves
  // against the live graph on each hop (dispatchHop only does that for
  // mode: "live" — "pinned", the API default, snapshots the graph once at
  // creation and ignores edits afterward). Previously createRun() here
  // never passed a mode at all, so mid-run reroutes from the main canvas
  // silently did nothing.
  const [liveMode, setLiveMode] = useState(true);
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
    const run = await createRun(graph.id, runInput.trim(), liveMode ? "live" : "pinned");
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
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--text-faint)" }} title="Re-resolves routing against the live graph on every hop, so dragging an edge mid-run actually reroutes it. Turn off to snapshot the graph once at start instead.">
                <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} />
                Live
              </label>
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
        <button type="button" onClick={resetLayout} title="Snap nodes back to their saved positions and re-fit the view">
          ↺ Reset layout
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
          // Remounts on "Reset layout" so the one-shot fitView prop below
          // re-fits against the restored positions too, not just the nodes/
          // edges state.
          key={resetCounter}
          nodes={nodes}
          edges={edgesWithPulses}
          edgeTypes={EDGE_TYPES}
          nodeExtent={nodeExtent}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onReconnect={onReconnect}
          // The default 10px activation zone around an edge's endpoint is
          // too fiddly to hit reliably — the drag-mid-run demo literally
          // failed on this once. 30px makes the reconnect anchor (drag from
          // the edge's end onto another node) easy to grab.
          reconnectRadius={30}
          onConnect={onConnect}
          onNodeClick={(_, node) => {
            const gatewayTargetId = (node.data as { isGateway?: boolean; targetGraphId?: string } | undefined)
              ?.targetGraphId;
            if (gatewayTargetId) {
              router.push(`/hierarchy?graphId=${gatewayTargetId}`);
              return;
            }
            setShowSchedules(false);
            setShowGitHub(false);
            setOpenAgentPanel(node.id);
          }}
          colorMode={theme}
          // Default minZoom (0.5) blocks fitView from zooming out past
          // that, so a graph with real vertical span (gateway row below
          // the real team) plus a short container (HierarchyChat's
          // embedded canvas splits the screen with the chat panel below
          // it) clips the bottom rather than shrinking further to fit it.
          minZoom={0.1}
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
