"use client";

import { useState } from "react";
import { createGraph, generateGraph } from "../../../lib/api";
import { useAuth } from "../../../components/AuthProvider";

type Mode = "describe" | "manual";

export default function NewGraphPage() {
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<Mode>("describe");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await createGraph(name);
      window.location.href = `/hierarchy?graphId=${graph.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create graph");
      setBusy(false);
    }
  }

  async function generate() {
    if (!description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await generateGraph(description.trim());
      window.location.href = `/hierarchy?graphId=${graph.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate graph");
      setBusy(false);
    }
  }

  if (loading) return null;
  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <p>
          <a href="/login">Log in</a> to create a graph.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 480 }}>
      <h1>New graph</h1>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        <button
          onClick={() => setMode("describe")}
          style={{
            background: mode === "describe" ? "var(--accent)" : "transparent",
            color: mode === "describe" ? "var(--accent-text)" : "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          Describe it
        </button>
        <button
          onClick={() => setMode("manual")}
          style={{
            background: mode === "manual" ? "var(--accent)" : "transparent",
            color: mode === "manual" ? "var(--accent-text)" : "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          Name it manually
        </button>
      </div>

      {mode === "describe" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            placeholder={'e.g. "A support triage team: a router that classifies tickets as billing or technical, and two specialists"'}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            style={{ resize: "vertical" }}
          />
          <p style={{ color: "var(--text-faint)", fontSize: 13, margin: 0 }}>
            An AI builds a real, editable multi-agent team from this description — you can inspect, edit, or rewire
            anything afterward on the canvas.
          </p>
          <button onClick={generate} disabled={busy || !description.trim()} style={{ alignSelf: "flex-start" }}>
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Graph name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button onClick={create} disabled={busy}>
            Create
          </button>
        </div>
      )}
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
