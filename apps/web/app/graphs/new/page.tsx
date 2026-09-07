"use client";

import { useState } from "react";
import { createGraph } from "../../../lib/api";
import { useAuth } from "../../../components/AuthProvider";

export default function NewGraphPage() {
  const { user, loading } = useAuth();
  const [name, setName] = useState("");
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
    <div style={{ padding: 24, maxWidth: 400 }}>
      <h1>New graph</h1>
      <div style={{ display: "flex", gap: 8 }}>
        <input placeholder="Graph name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
        <button onClick={create} disabled={busy}>
          Create
        </button>
      </div>
      {error && <p style={{ color: "#e74c3c" }}>{error}</p>}
    </div>
  );
}
