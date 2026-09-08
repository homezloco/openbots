"use client";

import { useEffect, useState } from "react";
import type { AgentGraph } from "@openbots/graph-schema";
import { fetchGraph, type GraphSummary } from "../lib/api";
import { extractLatestUserMessage, useBotChat } from "../lib/useBotChat";
import { HierarchyCanvas } from "./HierarchyCanvas";

/**
 * A multi-node graph's Dashboard view: the live hierarchy canvas (so you
 * watch it pulse while it runs) on top, and the same chat input/transcript
 * strip BotChat gives single-node bots underneath — same useBotChat hook,
 * so multi-agent "teams" get identical conversation continuity. Replaces
 * the old dead-end "Open in Hierarchy →" link; /hierarchy itself is
 * unchanged and still exists as the dedicated full-canvas editing surface.
 */
export function HierarchyChat({ graph }: { graph: GraphSummary }) {
  const [fullGraph, setFullGraph] = useState<AgentGraph | null>(null);

  useEffect(() => {
    setFullGraph(null);
    fetchGraph(graph.id)
      .then(setFullGraph)
      .catch(() => {});
  }, [graph.id]);

  const { runs, input, setInput, sending, error, send } = useBotChat(graph);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
        <strong>{graph.name}</strong>
        <a href={`/hierarchy?graphId=${graph.id}`}>Open full editor →</a>
      </div>

      <div style={{ flex: 3, minHeight: 0 }}>
        {fullGraph ? (
          <HierarchyCanvas graph={fullGraph} />
        ) : (
          <div style={{ padding: 24, color: "var(--text-faint)" }}>Loading hierarchy…</div>
        )}
      </div>

      <div style={{ flex: 2, minHeight: 0, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
          {runs.map((r) => (
            <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "70%",
                  background: "var(--accent)",
                  color: "var(--accent-text)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  whiteSpace: "pre-wrap",
                }}
              >
                {typeof r.input === "string" ? extractLatestUserMessage(r.input) : JSON.stringify(r.input)}
              </div>
              <div
                style={{
                  alignSelf: "flex-start",
                  maxWidth: "70%",
                  background: "var(--bg-hover)",
                  color: "var(--text)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  whiteSpace: "pre-wrap",
                }}
              >
                {typeof r.output === "string" ? r.output : JSON.stringify(r.output)}
              </div>
            </div>
          ))}
        </div>
        {error && <p style={{ color: "var(--danger)", padding: "0 16px" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, padding: 16 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Say something…"
            style={{ flex: 1 }}
          />
          <button onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
