"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentGraph } from "@openbots/graph-schema";
import { fetchGraph, type GraphSummary } from "../lib/api";
import { extractLatestUserMessage, useBotChat } from "../lib/useBotChat";
import { stripRoutingSentinel } from "../lib/textDisplay";
import { HierarchyCanvas } from "./HierarchyCanvas";
import { MicButton, VoiceReplyToggle } from "./VoiceControls";

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

  const { runs, input, setInput, sending, error, send, pending } = useBotChat(graph);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });

  const latestCompleted = [...runs].reverse().find((r) => r.status === "completed" && typeof r.output === "string");

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.length, pending]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
        <strong>{graph.name}</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <VoiceReplyToggle
            speakKey={latestCompleted?.id ?? null}
            text={latestCompleted ? stripRoutingSentinel(latestCompleted.output as string) : null}
          />
          <a href={`/hierarchy?graphId=${graph.id}`}>Open full editor →</a>
          <button onClick={scrollToBottom} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", padding: "4px 8px" }} title="Scroll to bottom">
            ↓
          </button>
        </div>
      </div>

      <div style={{ flex: 3, minHeight: 0 }}>
        {fullGraph ? (
          // key={fullGraph.id}: HierarchyCanvas seeds its state from this
          // prop via useState(initialGraph), which doesn't re-run on a
          // prop change alone — without a key, switching between graphs
          // in the Dashboard sidebar would keep rendering the previous
          // graph's stale nodes/edges. Same fix as app/hierarchy/page.tsx.
          <HierarchyCanvas key={fullGraph.id} graph={fullGraph} showStartRunButton={false} />
        ) : (
          <div style={{ padding: 24, color: "var(--text-faint)" }}>Loading hierarchy…</div>
        )}
      </div>

      <div style={{ flex: 2, minHeight: 0, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
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
                {(() => {
                  const shown = r.originalInput ?? r.input;
                  return typeof shown === "string" ? extractLatestUserMessage(shown) : JSON.stringify(shown);
                })()}
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
                {typeof r.output === "string" ? stripRoutingSentinel(r.output) : JSON.stringify(r.output)}
              </div>
            </div>
          ))}
          {pending && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                {pending.message}
              </div>
              <div style={{ alignSelf: "flex-start", maxWidth: "70%", color: "var(--text-faint)", borderRadius: 8, padding: "8px 12px" }}>
                {pending.status === "running" ? "Thinking…" : "Sending…"}
              </div>
            </div>
          )}
        </div>
        {error && <p style={{ color: "var(--danger)", padding: "0 16px" }}>{error}</p>}
        {voiceError && <p style={{ color: "var(--danger)", padding: "0 16px" }}>{voiceError}</p>}
        <div style={{ display: "flex", gap: 8, padding: 16 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Say something…"
            style={{ flex: 1 }}
          />
          <MicButton
            onTranscript={(text) => setInput(input ? `${input} ${text}` : text)}
            onError={setVoiceError}
            disabled={sending}
          />
          <button onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
