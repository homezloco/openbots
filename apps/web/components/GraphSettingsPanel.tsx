"use client";

import { useEffect, useState } from "react";
import type { AgentGraph } from "@openbots/graph-schema";
import { fetchGraph, updateGraph } from "../lib/api";
import { FallbackChainEditor } from "./FallbackChainEditor";

/**
 * Slide-over for a graph's own settings — name, description, and its
 * default fallback chain. The first place a graph's own properties become
 * editable after creation at all (PATCH /graphs/:id already supported
 * name/description, but nothing in the UI called it for either field).
 * Same visual shell as SchedulesPanel/WebhooksPanel.
 */
export function GraphSettingsPanel({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fallbackChain, setFallbackChain] = useState<AgentGraph["fallbackChain"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchGraph(graphId)
      .then((g) => {
        setGraph(g);
        setName(g.name);
        setDescription(g.description);
        setFallbackChain(g.fallbackChain);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load graph"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateGraph(graphId, { name: name.trim(), description, fallbackChain });
      setGraph(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save graph settings");
    } finally {
      setBusy(false);
    }
  }

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
        <strong>Graph settings</strong>
        <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!error && graph === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}

        {graph !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Description</span>
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Default fallback chain{" "}
                <span style={{ color: "var(--text-faint)" }}>
                  — used by any node whose own fallback chain is empty, and by this graph&apos;s prompt-generation
                  calls (quick-add, promptable workflow generation)
                </span>
              </span>
              <FallbackChainEditor value={fallbackChain} onChange={setFallbackChain} />
            </div>
            <button onClick={save} disabled={busy || !name.trim()} style={{ alignSelf: "flex-start" }}>
              {busy ? "Saving…" : "Save"}
            </button>
            {saved && !busy && <p style={{ color: "var(--success)", margin: 0 }}>Saved.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
