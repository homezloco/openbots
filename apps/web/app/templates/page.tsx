"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createTemplate, instantiateTemplate, listGraphs, listTemplates, type GraphSummary, type TemplateSummary } from "../../lib/api";
import { useAuth } from "../../components/AuthProvider";

/** Templates are self-contained graph snapshots you can instantiate into a fresh, owned graph. See PLAN.md. */
export default function TemplatesPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [sourceGraphId, setSourceGraphId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    listTemplates().then(setTemplates).catch((err) => setError(err.message));
    listGraphs().then(setGraphs).catch((err) => setError(err.message));
  }, [user]);

  async function saveAsTemplate() {
    if (!sourceGraphId || !name) return;
    setBusy(true);
    setError(null);
    try {
      await createTemplate(sourceGraphId, name);
      setTemplates(await listTemplates());
      setSourceGraphId("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setBusy(false);
    }
  }

  async function useTemplate(templateId: string) {
    setBusy(true);
    setError(null);
    try {
      const graph = await instantiateTemplate(templateId);
      router.push(`/hierarchy?graphId=${graph.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to instantiate template");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;
  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Templates</h1>
        <p>
          <a href="/login">Log in</a> to see your templates.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <h1>Templates</h1>

      {user && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginBottom: 24 }}>
          <h2 style={{ marginTop: 0 }}>Save a graph as a template</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Source graph</span>
              <select value={sourceGraphId} onChange={(e) => setSourceGraphId(e.target.value)} style={{ width: "100%" }}>
                <option value="">Select a graph…</option>
                {graphs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.nodeCount} agent{g.nodeCount === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Template name</span>
              <input placeholder="e.g. PR review team" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
            </label>
            <button onClick={saveAsTemplate} disabled={busy || !sourceGraphId || !name}>
              Save
            </button>
          </div>
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {templates.map((t) => (
          <li key={t.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, display: "flex", justifyContent: "space-between" }}>
            <div>
              <strong>{t.name}</strong>
              <p style={{ margin: "4px 0", color: "var(--text-muted)" }}>{t.description || "No description"}</p>
              <small>{t.nodeCount} agents</small>
            </div>
            <button onClick={() => useTemplate(t.id)} disabled={busy || !user}>
              Use this template
            </button>
          </li>
        ))}
        {templates.length === 0 && <p>No templates yet.</p>}
      </ul>
    </div>
  );
}
