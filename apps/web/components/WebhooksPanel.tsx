"use client";

import { useEffect, useState } from "react";
import {
  createWebhook,
  deleteWebhook,
  listWebhookRuns,
  listWebhooks,
  rotateWebhook,
  updateWebhook,
  type WebhookRunSummary,
  type WebhookTrigger,
} from "../lib/api";

// Same fallback lib/api.ts's own request() helper uses to reach the API —
// display-only here, not a security boundary. A self-hosted operator behind
// a reverse proxy on a different public domain needs to manually substitute
// their real public hostname when pasting the URL into a third-party sender.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Slide-over for a graph's webhook triggers (apps/api/src/routes/
 * webhookTriggers.ts) — same visual pattern as SchedulesPanel, but the
 * firing secret (`token`) is only ever present in a create/rotate
 * response, shown once, then gone for good — never retrievable again,
 * same "shown once" pattern as a GitHub PAT.
 */
export function WebhooksPanel({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const [webhooks, setWebhooks] = useState<WebhookTrigger[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealedUrl, setRevealedUrl] = useState<{ id: string; url: string } | null>(null);

  const [name, setName] = useState("");
  const [mode, setMode] = useState<"pinned" | "live">("pinned");

  function refresh() {
    return listWebhooks(graphId)
      .then(setWebhooks)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load webhooks"));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createWebhook(graphId, { name: name.trim(), mode });
      setRevealedUrl({ id: created.id, url: `${API_URL}/webhooks/${created.token}` });
      await refresh();
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(webhook: WebhookTrigger) {
    setBusy(true);
    setError(null);
    try {
      await updateWebhook(graphId, webhook.id, { enabled: !webhook.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update webhook");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const rotated = await rotateWebhook(graphId, id);
      setRevealedUrl({ id: rotated.id, url: `${API_URL}/webhooks/${rotated.token}` });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate webhook");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteWebhook(graphId, id);
      if (revealedUrl?.id === id) setRevealedUrl(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete webhook");
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
        <strong>Webhooks</strong>
        <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Name</span>
            <input placeholder="e.g. Stripe checkout" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Run mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "pinned" | "live")}>
              <option value="pinned">Pinned (graph snapshot at run time)</option>
              <option value="live">Live (re-resolves routing on every hop)</option>
            </select>
          </label>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
            The whole JSON body posted to the webhook becomes that run&apos;s input. Anyone who has the URL can
            trigger a run — treat it like a password; there&apos;s no other check.
          </p>
          <button onClick={create} disabled={busy || !name.trim()} style={{ alignSelf: "flex-start" }}>
            Add webhook
          </button>
        </div>

        {webhooks === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}
        {webhooks?.length === 0 && <p style={{ color: "var(--text-faint)" }}>No webhooks yet.</p>}
        {webhooks?.map((w) => (
          <WebhookCard
            key={w.id}
            graphId={graphId}
            webhook={w}
            busy={busy}
            revealedUrl={revealedUrl?.id === w.id ? revealedUrl.url : null}
            onDismissReveal={() => setRevealedUrl(null)}
            onToggle={() => toggleEnabled(w)}
            onRotate={() => rotate(w.id)}
            onDelete={() => remove(w.id)}
          />
        ))}
      </div>
    </div>
  );
}

function WebhookCard({
  graphId,
  webhook: w,
  busy,
  revealedUrl,
  onDismissReveal,
  onToggle,
  onRotate,
  onDelete,
}: {
  graphId: string;
  webhook: WebhookTrigger;
  busy: boolean;
  revealedUrl: string | null;
  onDismissReveal: () => void;
  onToggle: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<WebhookRunSummary[] | null>(null);
  const [copied, setCopied] = useState(false);

  function toggleHistory() {
    setShowHistory((v) => !v);
    if (!history) listWebhookRuns(graphId, w.id).then(setHistory).catch(() => setHistory([]));
  }

  function copy() {
    if (!revealedUrl) return;
    navigator.clipboard?.writeText(revealedUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <strong>{w.name}</strong>
        <span style={{ fontSize: 12, color: w.enabled ? "var(--status-succeeded)" : "var(--text-faint)" }}>
          {w.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-muted)" }}>
        {w.lastTriggeredAt ? (
          <>
            Last fired {new Date(w.lastTriggeredAt).toLocaleString()}
            {w.lastRunId && (
              <>
                {" — "}
                <a href={`/runs/${w.lastRunId}`}>view run</a>
              </>
            )}
          </>
        ) : (
          "Never fired yet"
        )}
      </p>

      {revealedUrl && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8, margin: "8px 0", background: "var(--bg-subtle, transparent)" }}>
          <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600 }}>
            This URL won&apos;t be shown again — copy it now.
          </p>
          <code style={{ display: "block", fontSize: 12, wordBreak: "break-all", marginBottom: 6 }}>{revealedUrl}</code>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={onDismissReveal} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
              Done
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={onToggle} disabled={busy}>
          {w.enabled ? "Disable" : "Enable"}
        </button>
        <button onClick={onRotate} disabled={busy}>
          Rotate URL
        </button>
        <button onClick={toggleHistory} disabled={busy}>
          {showHistory ? "Hide history" : "View history"}
        </button>
        <button onClick={onDelete} disabled={busy} style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--border)" }}>
          Delete
        </button>
      </div>
      {showHistory && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          {history === null && <p style={{ color: "var(--text-faint)", fontSize: 13 }}>Loading…</p>}
          {history?.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 13 }}>No firings yet.</p>}
          {history?.map((r) => (
            <p key={r.id} style={{ margin: "4px 0", fontSize: 13 }}>
              <a href={`/runs/${r.id}`}>{new Date(r.createdAt).toLocaleString()}</a>{" "}
              <span style={{ color: "var(--text-muted)" }}>({r.status})</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
