"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createUserCredential, deleteUserCredential, listUserCredentials, type UserCredentialSummary } from "../../lib/api";
import { useAuth } from "../../components/AuthProvider";

/**
 * Account-scoped credentials the /push chat command uses (apps/api/src/
 * routes/userCredentials.ts): a GitHub token for an https:// origin, or an
 * SSH private key for a git@/ssh:// origin (github.com only — see
 * gitWorktree.ts's pinned host key). Separate from the per-graph AI
 * provider keys managed inside each graph's own settings.
 */
export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const [credentials, setCredentials] = useState<UserCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return listUserCredentials()
      .then(setCredentials)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load credentials"));
  }

  useEffect(() => {
    if (!user) return;
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <CredentialSection
        title="GitHub token"
        description={
          <>
            Used by the <code>/push</code> chat command for an <code>https://</code> origin remote, and always required by{" "}
            <code>/pr</code> (opening a PR goes through GitHub&apos;s REST API, not git&apos;s transport — even if you pushed over
            SSH). One token for your whole account, reused across every graph you own — see docs/orchestration.md. Needs{" "}
            <code>repo</code> scope for a classic token, or Contents + Pull requests: read/write for a fine-grained one.
          </>
        }
        provider="github"
        placeholder="ghp_…"
        multiline={false}
        credentials={credentials}
        loading={loading}
        onError={setError}
        onSaved={refresh}
      />

      <CredentialSection
        title="SSH private key"
        description={
          <>
            Used by <code>/push</code> for a <code>git@</code>/<code>ssh://</code> origin remote — <code>github.com</code> only in v1
            (the pinned host key is GitHub&apos;s). Paste the private key exactly as generated (e.g. an unencrypted{" "}
            <code>id_ed25519</code>), matching a deploy key or SSH key already added to the GitHub account that owns the repo.
          </>
        }
        provider="github_ssh_key"
        placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
        multiline
        credentials={credentials}
        loading={loading}
        onError={setError}
        onSaved={refresh}
      />

      <h2 style={{ marginTop: 32, marginBottom: 4 }}>Business metrics</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
        Lets an agent with the <code>business_metrics</code> tool read real conversion/revenue/traffic numbers instead of only
        what you type in chat. Each property logs in with its own existing staff/admin account — nothing new to create there.
      </p>

      <MetricsCredentialSection
        title="leadgen-a.example"
        provider="metrics_leadgen-a"
        credentials={credentials}
        loading={loading}
        onError={setError}
        onSaved={refresh}
      />
      <MetricsCredentialSection
        title="leadgen-b.example"
        provider="metrics_leadgen-b"
        credentials={credentials}
        loading={loading}
        onError={setError}
        onSaved={refresh}
      />
      <MetricsCredentialSection
        title="saas-b.example"
        provider="metrics_saas-b"
        description="Traffic/usage only — saas-b has no revenue endpoint yet."
        credentials={credentials}
        loading={loading}
        onError={setError}
        onSaved={refresh}
      />
    </div>
  );
}

function CredentialSection({
  title,
  description,
  provider,
  placeholder,
  multiline,
  credentials,
  loading,
  onError,
  onSaved,
}: {
  title: string;
  description: ReactNode;
  provider: string;
  placeholder: string;
  multiline: boolean;
  credentials: UserCredentialSummary[];
  loading: boolean;
  onError: (message: string | null) => void;
  onSaved: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const existing = credentials.find((c) => c.provider === provider);

  async function save() {
    if (!apiKey.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await createUserCredential({ provider, apiKey: apiKey.trim(), label: label.trim() || undefined });
      await onSaved();
      setApiKey("");
      setLabel("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    onError(null);
    try {
      await deleteUserCredential(id);
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{description}</p>

      {loading ? (
        <p>Loading…</p>
      ) : existing ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            <strong>{existing.label || title}</strong>
            <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 13 }}>
              Saved {new Date(existing.createdAt).toLocaleDateString()}
            </p>
          </div>
          <button onClick={() => remove(existing.id)} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {multiline ? (
              <textarea
                placeholder={placeholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                rows={6}
                style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
              />
            ) : (
              <input type="password" placeholder={placeholder} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            )}
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Label (optional)</span>
            <input placeholder="e.g. personal GitHub account" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button onClick={save} disabled={busy || !apiKey.trim()} style={{ alignSelf: "flex-start" }}>
            Save
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Separate from CredentialSection because the underlying credential value
 * is a username+password pair, not a single token/key — JSON-encoded
 * client-side into the same encryptedKey string field before POST
 * /me/credentials (no schema change on the backend), decoded back out by
 * businessMetricsTool.ts on use. Never render the raw JSON to the user.
 */
function MetricsCredentialSection({
  title,
  provider,
  description,
  credentials,
  loading,
  onError,
  onSaved,
}: {
  title: string;
  provider: string;
  description?: string;
  credentials: UserCredentialSummary[];
  loading: boolean;
  onError: (message: string | null) => void;
  onSaved: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const existing = credentials.find((c) => c.provider === provider);

  async function save() {
    if (!username.trim() || !password) return;
    setBusy(true);
    onError(null);
    try {
      await createUserCredential({ provider, apiKey: JSON.stringify({ username: username.trim(), password }) });
      await onSaved();
      setUsername("");
      setPassword("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    onError(null);
    try {
      await deleteUserCredential(id);
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 16, marginTop: 12 }}>
      <h3 style={{ marginTop: 0, marginBottom: description ? 4 : 12 }}>{title}</h3>
      {description && <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 0 }}>{description}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : existing ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Saved {new Date(existing.createdAt).toLocaleDateString()}</p>
          <button onClick={() => remove(existing.id)} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button onClick={save} disabled={busy || !username.trim() || !password}>
            Save
          </button>
        </div>
      )}
    </section>
  );
}
