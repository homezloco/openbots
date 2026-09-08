"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentNode } from "@openbots/graph-schema";
import { fetchAgentConversations, type AgentConversation } from "../lib/api";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { RunEventTrail } from "./RunEventTrail";

/**
 * Slide-over opened by clicking a node on the Hierarchy canvas: every run
 * this agent has ever been part of, most recent first, distinguishing
 * runs the user talked to it directly (this node was the entry hop) from
 * runs where another agent routed to it. The gear icon swaps this same
 * panel over to an inline settings form instead of stacking a second
 * overlay on top.
 */
export function AgentConversationPanel({
  graphId,
  node,
  onClose,
  onNodeUpdated,
}: {
  graphId: string;
  node: AgentNode;
  onClose: () => void;
  onNodeUpdated: (updated: AgentNode) => void;
}) {
  const [view, setView] = useState<"history" | "settings">("history");
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<AgentConversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });

  useEffect(() => {
    setConversations(null);
    setError(null);
    fetchAgentConversations(graphId, node.id)
      .then((res) => {
        setNodeNames(Object.fromEntries(res.nodes.map((n) => [n.id, n.name])));
        setConversations(res.runs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load conversations"));
  }, [graphId, node.id]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        maxWidth: "90%",
        background: "var(--bg)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "-4px 0 12px rgba(0,0,0,0.15)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottom: "1px solid var(--border)" }}>
        <strong>{node.name}</strong>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              onClick={() => setView("history")}
              style={{
                background: view === "history" ? "var(--accent)" : "transparent",
                color: view === "history" ? "var(--accent-text)" : "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              History
            </button>
            <button
              onClick={() => setView("settings")}
              style={{
                background: view === "settings" ? "var(--accent)" : "transparent",
                color: view === "settings" ? "var(--accent-text)" : "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              Settings
            </button>
          </div>
          <button onClick={scrollToBottom} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", padding: "4px 8px" }} title="Scroll to bottom">
            ↓
          </button>
          <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
            ✕
          </button>
        </div>
      </div>

      {view === "settings" ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <AgentSettingsForm
            graphId={graphId}
            node={node}
            onCancel={() => setView("history")}
            onSaved={(updated) => {
              onNodeUpdated(updated);
              setView("history");
            }}
          />
        </div>
      ) : (
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          {!error && conversations === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}
          {conversations?.length === 0 && <p style={{ color: "var(--text-faint)" }}>No runs have involved this agent yet.</p>}
          {conversations?.map((c) => (
            <div key={c.runId} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
                <span>{c.isDirect ? "💬 Direct" : "↳ Routed"}</span>
                <a href={`/runs/${c.runId}`} style={{ fontSize: 13 }}>
                  {new Date(c.startedAt).toLocaleString()}
                </a>
                <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{c.status}</span>
              </div>
              <RunEventTrail events={c.events} nodeNames={nodeNames} focusNodeId={node.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
