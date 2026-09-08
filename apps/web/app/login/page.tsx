"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, signup } from "../../lib/api";
import { useAuth } from "../../components/AuthProvider";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { refresh } = useAuth();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "login") await login(email, password);
      else await signup(email, password);
      await refresh();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100%", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 32 }}>OpenBots</h1>
          <p style={{ margin: 0, color: "var(--text-muted)" }}>Open-source, model-agnostic multi-agent orchestration</p>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 24, background: "var(--bg-elevated)" }}>
          <h2 style={{ margin: "0 0 16px", fontSize: 20 }}>{mode === "login" ? "Log in" : "Sign up"}</h2>
          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Email</span>
              <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Password</span>
              <input
                type="password"
                placeholder="Password (min 8 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
            <button type="submit" disabled={submitting} style={{ width: "100%" }}>
              {submitting ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            style={{ marginTop: 16, width: "100%", background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
          >
            {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
          </button>
        </div>
      </div>
    </div>
  );
}
