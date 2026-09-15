"use client";

import { useEffect, useRef, useState } from "react";
import { createAgencyExample, createLiveRerouteExample, deleteGraph, generateGraph, listGraphs, type GraphSummary } from "../../lib/api";
import { extractLatestUserMessage, useBotChat } from "../../lib/useBotChat";
import { stripRoutingSentinel } from "../../lib/textDisplay";
import { useAuth } from "../../components/AuthProvider";
import { HierarchyChat } from "../../components/HierarchyChat";
import { MicButton, VoiceReplyToggle } from "../../components/VoiceControls";

/**
 * The bot roster (Grok Bot's sidebar-of-bots pattern): every graph you own,
 * listed like contacts. A single-node graph gets a chat view right here; a
 * multi-node graph gets HierarchyChat — the live canvas plus the same chat
 * input/transcript strip, instead of the old dead-end "Open in Hierarchy"
 * link. See PLAN.md.
 *
 * Conversation memory (useBotChat, shared with HierarchyChat) is built by
 * chaining each completed run's own transcript forward — no backend/schema
 * change needed. A run's `input` therefore holds the FULL transcript so
 * far; the UI recovers just this turn's message with extractLatestUserMessage.
 */
export default function DashboardPage() {
  const { user, loading } = useAuth();
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingExample, setCreatingExample] = useState<"reroute" | "agency" | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refreshGraphs() {
    const gs = await listGraphs();
    setGraphs(gs);
    return gs;
  }

  useEffect(() => {
    if (!user) return;
    refreshGraphs()
      .then((gs) => {
        // Land on whichever graph you were most recently chatting with,
        // rather than making you click one every time. lastRunAt (not
        // updatedAt, which is the last STRUCTURAL edit) is the right
        // signal; a graph that's never been run falls back to createdAt
        // so a brand-new user still lands somewhere sensible.
        setSelectedId((current) => {
          if (current || gs.length === 0) return current;
          const activityTime = (g: GraphSummary) => new Date(g.lastRunAt ?? g.createdAt).getTime();
          return gs.reduce((latest, g) => (activityTime(g) > activityTime(latest) ? g : latest), gs[0]).id;
        });
      })
      .catch((err) => setError(err.message));
  }, [user]);

  // The roster has no websocket (that's reserved for live run events within
  // one already-open graph, see useRunEventsSocket) — a graph created or
  // renamed some other way (another tab, a script, another device) would
  // otherwise only show up after a manual reload. Cheap enough to just poll;
  // failures are silent since a transient miss shouldn't flash an error
  // banner every few seconds.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      refreshGraphs().catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function createBot() {
    if (!description.trim()) return;
    setCreating(true);
    setError(null);
    try {
      // "Describe a new one" should build a whole team, not one agent —
      // it calls the full-graph generator, not quick-add (which is for
      // adding a single agent inside an existing graph). This whole
      // handler previously created a graph + ONE quick-add node, so any
      // multi-department description collapsed to a lone coordinator.
      const graph = await generateGraph(description);
      setDescription("");
      await refreshGraphs();
      setSelectedId(graph.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create bot");
    } finally {
      setCreating(false);
    }
  }

  async function removeGraph(id: string, name: string) {
    if (!window.confirm(`Delete graph “${name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteGraph(id);
      const gs = await refreshGraphs();
      setSelectedId((current) => {
        if (current !== id) return current;
        return gs[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete graph");
    }
  }

  async function createDemo() {
    setCreatingExample("reroute");
    setError(null);
    try {
      const graph = await createLiveRerouteExample();
      window.location.href = `/hierarchy?graphId=${graph.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create demo");
      setCreatingExample(null);
    }
  }

  async function createAgency() {
    setCreatingExample("agency");
    setError(null);
    try {
      const graph = await createAgencyExample();
      window.location.href = `/hierarchy?graphId=${graph.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agency demo");
      setCreatingExample(null);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, color: "var(--text-faint)" }}>
        <p>Loading your bots…</p>
      </div>
    );
  }
  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <p>
          <a href="/login">Log in</a> to see your bots.
        </p>
      </div>
    );
  }

  const selected = graphs.find((g) => g.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <aside style={{ width: 280, padding: 16, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
        <div>
          <textarea
            placeholder='Describe a new bot, e.g. "Summarizes incoming support tickets"'
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ width: "100%" }}
          />
          <button onClick={createBot} disabled={creating || creatingExample !== null} style={{ width: "100%", marginTop: 4 }}>
            {creating ? "Creating…" : "+ New bot"}
          </button>
          <button
            onClick={createDemo}
            disabled={creating || creatingExample !== null}
            style={{ width: "100%", marginTop: 4, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {creatingExample === "reroute" ? "Creating…" : "Try the live-reroute demo"}
          </button>
          <button
            onClick={createAgency}
            disabled={creating || creatingExample !== null}
            style={{ width: "100%", marginTop: 4, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {creatingExample === "agency" ? "Creating…" : "Try the agency demo"}
          </button>
        </div>

        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {graphs.map((g) => (
            <li key={g.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button
                onClick={() => setSelectedId(g.id)}
                style={{
                  flex: 1,
                  textAlign: "left",
                  padding: 8,
                  background: g.id === selectedId ? "var(--bg-hover)" : "transparent",
                  color: "var(--text)",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {g.name} <small style={{ color: "var(--text-faint)" }}>({g.nodeCount} agent{g.nodeCount === 1 ? "" : "s"})</small>
              </button>
              {g.id === selectedId && (
                <button
                  type="button"
                  title="Delete this graph"
                  onClick={() => removeGraph(g.id, g.name)}
                  style={{ background: "transparent", color: "var(--text-faint)", border: "1px solid var(--border)", padding: "4px 8px" }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {graphs.length === 0 && (
          <div style={{ padding: "12px 0", color: "var(--text-faint)" }}>
            <p style={{ margin: "0 0 8px" }}>No bots yet.</p>
            <p style={{ margin: 0, fontSize: 13 }}>
              Describe a job above, start from the live-reroute demo (the README GIF), or try the agency demo (Portfolio → click a dashed gateway into a team).
            </p>
          </div>
        )}
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {!selected && (
          <div style={{ padding: 24, color: "var(--text-faint)", textAlign: "center" }}>
            <p style={{ margin: 0 }}>Select a bot from the sidebar, or describe a new one above.</p>
          </div>
        )}
        {selected && selected.nodeCount === 1 && <BotChat graph={selected} />}
        {selected && selected.nodeCount !== 1 && <HierarchyChat graph={selected} />}
      </div>
    </div>
  );
}

function BotChat({ graph }: { graph: GraphSummary }) {
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
    <>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
        <strong>{graph.name}</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <VoiceReplyToggle
            speakKey={latestCompleted?.id ?? null}
            text={latestCompleted ? stripRoutingSentinel(latestCompleted.output as string) : null}
            onError={setVoiceError}
          />
          <a href={`/hierarchy?graphId=${graph.id}`}>View in Hierarchy</a>
          <button onClick={scrollToBottom} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", padding: "4px 8px" }} title="Scroll to bottom">
            ↓
          </button>
        </div>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        {runs.map((r) => (
          <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ alignSelf: "flex-end", maxWidth: "70%", background: "var(--accent)", color: "var(--accent-text)", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap" }}>
              {(() => {
                const shown = r.originalInput ?? r.input;
                return typeof shown === "string" ? extractLatestUserMessage(shown) : JSON.stringify(shown);
              })()}
            </div>
            <div style={{ alignSelf: "flex-start", maxWidth: "70%", background: "var(--bg-hover)", color: "var(--text)", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap" }}>
              {typeof r.output === "string" ? stripRoutingSentinel(r.output) : JSON.stringify(r.output)}
            </div>
          </div>
        ))}
        {pending && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ alignSelf: "flex-end", maxWidth: "70%", background: "var(--accent)", color: "var(--accent-text)", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap" }}>
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
    </>
  );
}
