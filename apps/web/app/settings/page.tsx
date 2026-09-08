"use client";

import { useEffect, useState } from "react";
import { createUserCredential, deleteUserCredential, listUserCredentials, type UserCredentialSummary } from "../../lib/api";
import { useAuth } from "../../components/AuthProvider";

/**
 * Account-scoped credentials — currently just the single GitHub token
 * /push uses (apps/api/src/routes/userCredentials.ts). Separate from the
 * per-graph AI provider keys managed inside each graph's own settings.
 */
export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const [credentials, setCredentials] = useState<UserCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    listUserCredentials()
      .then(setCredentials)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load credentials"))
      .finally(() => setLoading(false));
  }, [user]);

  const githubCredential = credentials.find((c) => c.provider === "github");

  async function saveToken() {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createUserCredential({ provider: "github", apiKey: apiKey.trim(), label: label.trim() || undefined });
      setCredentials(await listUserCredentials());
      setApiKey("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save token");
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteUserCredential(id);
      setCredentials(await listUserCredentials());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove token");
    } finally {
      setBusy(false);
    }
  }

  if (authLoading) return null;

  if (!user) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h1>Settings</h1>
        <p>
          <a href="/login">Log in</a> to manage your account settings.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <h1>Settings</h1>

      <section style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>GitHub token</h2>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Used by the <code>/push</code> chat command to push a write-capable agent&apos;s committed branch to its origin remote over
          HTTPS. One token for your whole account, reused across every graph you own — see docs/orchestration.md. The token is
          encrypted at rest and never shown again after you save it.
        </p>

        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

        {loading ? (
          <p>Loading…</p>
        ) : githubCredential ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <strong>{githubCredential.label || "GitHub token"}</strong>
              <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 13 }}>
                Saved {new Date(githubCredential.createdAt).toLocaleDateString()}
              </p>
            </div>
            <button onClick={() => removeCredential(githubCredential.id)} disabled={busy}>
              Remove
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Personal access token (needs <code>repo</code> scope for a classic token, or Contents: read/write for a fine-grained one)
              </span>
              <input type="password" placeholder="ghp_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Label (optional)</span>
              <input placeholder="e.g. personal GitHub account" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <button onClick={saveToken} disabled={busy || !apiKey.trim()} style={{ alignSelf: "flex-start" }}>
              Save token
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
