"use client";

import { useEffect, useState } from "react";
import {
  createGraph,
  createRun,
  fetchRun,
  listGraphs,
  listRuns,
  quickAddAgent,
  updateGraph,
  type GraphSummary,
  type Run,
} from "../../lib/api";
import { useAuth } from "../../components/AuthProvider";

/**
 * The bot roster (Grok Bot's sidebar-of-bots pattern): every graph you own,
 * listed like contacts. A single-node graph gets a chat view right here; a
 * multi-node graph is a real pipeline and links to Hierarchy instead. See
 * PLAN.md.
 *
 * Conversation memory is built by chaining each completed run's own
 * transcript forward — no backend/schema change needed, see buildNextInput
 * below. A run's `input` therefore holds the FULL transcript so far; the UI
 * recovers just this turn's message with extractLatestUserMessage.
 */
export default function DashboardPage() {
  const { user, loading } = useAuth();
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refreshGraphs() {
    const gs = await listGraphs();
    setGraphs(gs);
    return gs;
  }

  useEffect(() => {
    if (user) refreshGraphs().catch((err) => setError(err.message));
  }, [user]);

  async function createBot() {
    if (!description.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const graph = await createGraph("New bot");
      const node = await quickAddAgent(graph.id, { description });
      await updateGraph(graph.id, { name: node.name, entryNodeId: node.id });
      setDescription("");
      await refreshGraphs();
      setSelectedId(graph.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create bot");
    } finally {
      setCreating(false);
    }
  }

  if (loading) return null;
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
      <aside style={{ width: 280, padding: 16, borderRight: "1px solid #eee", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
        <div>
          <textarea
            placeholder='Describe a new bot, e.g. "Summarizes incoming support tickets"'
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ width: "100%" }}
          />
          <button onClick={createBot} disabled={creating} style={{ width: "100%", marginTop: 4 }}>
            {creating ? "Creating…" : "+ New bot"}
          </button>
        </div>

        {error && <p style={{ color: "#e74c3c" }}>{error}</p>}

        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {graphs.map((g) => (
            <li key={g.id}>
              <button
                onClick={() => setSelectedId(g.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: 8,
                  background: g.id === selectedId ? "#f0f0f0" : "transparent",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {g.name} <small style={{ color: "#999" }}>({g.nodeCount} agent{g.nodeCount === 1 ? "" : "s"})</small>
              </button>
            </li>
          ))}
          {graphs.length === 0 && <p style={{ color: "#999" }}>No bots yet — describe one above.</p>}
        </ul>
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {!selected && (
          <div style={{ padding: 24, color: "#999" }}>Select a bot on the left, or describe a new one.</div>
        )}
        {selected && selected.nodeCount === 1 && <BotChat graph={selected} />}
        {selected && selected.nodeCount !== 1 && (
          <div style={{ padding: 24 }}>
            <p>
              "{selected.name}" has {selected.nodeCount} agents — that's a real pipeline, not a single bot.
            </p>
            <a href={`/hierarchy?graphId=${selected.id}`}>Open in Hierarchy →</a>
          </div>
        )}
      </div>
    </div>
  );
}

function extractLatestUserMessage(transcript: string): string {
  const idx = transcript.lastIndexOf("User: ");
  return idx === -1 ? transcript : transcript.slice(idx + "User: ".length);
}

function buildNextInput(lastCompletedRun: Run | null, newMessage: string): string {
  if (!lastCompletedRun || typeof lastCompletedRun.input !== "string") return `User: ${newMessage}`;
  return `${lastCompletedRun.input}\nAssistant: ${lastCompletedRun.output}\nUser: ${newMessage}`;
}

function BotChat({ graph }: { graph: GraphSummary }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadHistory() {
    const rows = await listRuns(graph.id);
    const chronological = rows
      .filter((r) => r.status === "completed")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    setRuns(chronological);
  }

  useEffect(() => {
    loadHistory().catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.id]);

  async function send() {
    if (!input.trim()) return;
    const message = input;
    setInput("");
    setSending(true);
    setError(null);
    try {
      const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
      const nextInput = buildNextInput(lastRun, message);
      const created = await createRun(graph.id, nextInput);

      let final = await fetchRun(created.id);
      for (let i = 0; i < 30 && final.status !== "completed" && final.status !== "error"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        final = await fetchRun(created.id);
      }
      if (final.status === "error") throw new Error("The bot failed to respond — check its Hierarchy/Runs view for details");
      setRuns((r) => [...r, final]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between" }}>
        <strong>{graph.name}</strong>
        <a href={`/hierarchy?graphId=${graph.id}`}>View in Hierarchy</a>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        {runs.map((r) => (
          <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ alignSelf: "flex-end", maxWidth: "70%", background: "#111", color: "#fff", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap" }}>
              {typeof r.input === "string" ? extractLatestUserMessage(r.input) : JSON.stringify(r.input)}
            </div>
            <div style={{ alignSelf: "flex-start", maxWidth: "70%", background: "#f0f0f0", borderRadius: 8, padding: "8px 12px", whiteSpace: "pre-wrap" }}>
              {typeof r.output === "string" ? r.output : JSON.stringify(r.output)}
            </div>
          </div>
        ))}
      </div>
      {error && <p style={{ color: "#e74c3c", padding: "0 16px" }}>{error}</p>}
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
    </>
  );
}
