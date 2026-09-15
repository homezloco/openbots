"use client";

import { useEffect, useState } from "react";
import type { AgentGraph, ProviderId } from "@openbots/graph-schema";
import {
  createCredential,
  deleteCredential,
  fetchGraph,
  listCredentials,
  updateGraph,
  type ProviderCredentialSummary,
} from "../lib/api";
import { FallbackChainEditor } from "./FallbackChainEditor";

const BYOK_PROVIDERS: ProviderId[] = ["anthropic", "openai", "xai", "openrouter", "openai-compatible"];

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

  // BYOK: keys stored encrypted server-side (provider_credentials), win
  // over env vars for every node in this graph — or one node when scoped.
  const [credentials, setCredentials] = useState<ProviderCredentialSummary[]>([]);
  const [credProvider, setCredProvider] = useState<ProviderId>("anthropic");
  const [credNodeId, setCredNodeId] = useState("");
  const [credLabel, setCredLabel] = useState("");
  const [credKey, setCredKey] = useState("");
  const [credBusy, setCredBusy] = useState(false);

  useEffect(() => {
    fetchGraph(graphId)
      .then((g) => {
        setGraph(g);
        setName(g.name);
        setDescription(g.description);
        setFallbackChain(g.fallbackChain);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load graph"));
    listCredentials(graphId)
      .then(setCredentials)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  const nodeNameById = new Map((graph?.nodes ?? []).map((n) => [n.id, n.name]));

  async function addCredential() {
    if (!credKey.trim()) return;
    setCredBusy(true);
    setError(null);
    try {
      const created = await createCredential(graphId, {
        provider: credProvider,
        apiKey: credKey.trim(),
        ...(credLabel.trim() ? { label: credLabel.trim() } : {}),
        ...(credNodeId ? { nodeId: credNodeId } : {}),
      });
      setCredentials((c) => [...c, created]);
      setCredKey("");
      setCredLabel("");
      setCredNodeId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setCredBusy(false);
    }
  }

  async function removeCredential(id: string) {
    setCredBusy(true);
    setError(null);
    try {
      await deleteCredential(graphId, id);
      setCredentials((c) => c.filter((x) => x.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete credential");
    } finally {
      setCredBusy(false);
    }
  }

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

            <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Model credentials{" "}
                <span style={{ color: "var(--text-faint)" }}>
                  — bring your own key; overrides the server&apos;s env key for this graph (or one node). Stored
                  encrypted, never shown again.
                </span>
              </span>
              {credentials.map((c) => (
                <div
                  key={c.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}
                >
                  <span>
                    <strong>{c.provider}</strong>
                    {c.nodeId ? ` → ${nodeNameById.get(c.nodeId) ?? "deleted node"}` : " → whole graph"}
                    {c.label ? ` (${c.label})` : ""}
                  </span>
                  <button
                    onClick={() => removeCredential(c.id)}
                    disabled={credBusy}
                    style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--border)" }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {credentials.length === 0 && (
                <span style={{ fontSize: 13, color: "var(--text-faint)" }}>No keys stored — env key is used.</span>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <select value={credProvider} onChange={(e) => setCredProvider(e.target.value as ProviderId)} style={{ flex: 1 }}>
                  {BYOK_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select value={credNodeId} onChange={(e) => setCredNodeId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">whole graph</option>
                  {(graph?.nodes ?? []).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
              <input
                placeholder="Label (optional)"
                value={credLabel}
                onChange={(e) => setCredLabel(e.target.value)}
              />
              <input
                type="password"
                placeholder="API key"
                value={credKey}
                onChange={(e) => setCredKey(e.target.value)}
              />
              <button onClick={addCredential} disabled={credBusy || !credKey.trim()} style={{ alignSelf: "flex-start" }}>
                {credBusy ? "Saving…" : "Add key"}
              </button>
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
