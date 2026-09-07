"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { listRuns, type Run } from "../../lib/api";
import { GraphPicker } from "../../components/GraphPicker";
import { useAuth } from "../../components/AuthProvider";

const STATUS_COLOR: Record<string, string> = {
  running: "var(--status-running)",
  pending: "var(--status-neutral)",
  error: "var(--status-failed)",
  completed: "var(--status-succeeded)",
  cancelled: "var(--status-neutral)",
};

/**
 * Companion to the hierarchy canvas: a state-sorted triage list (running
 * first, then everything else by recency) — the API already sorts this
 * way, mirroring Grok Build's dashboard pattern. See PLAN.md.
 *
 * Client component (not a server component) because GET /graphs/:id/runs
 * requires the session cookie, which a server-rendered fetch can't carry —
 * this crashed with an opaque "Server Components render" error once the
 * endpoint was locked down in the security review. Same fix as GraphPicker.
 * useSearchParams() needs a Suspense boundary per Next.js — hence the split.
 */
export default function RunsPage() {
  return (
    <Suspense fallback={null}>
      <RunsPageContent />
    </Suspense>
  );
}

function RunsPageContent() {
  const graphId = useSearchParams().get("graphId");
  const { user, loading } = useAuth();
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && graphId) {
      listRuns(graphId).then(setRuns).catch((err) => setError(err.message));
    }
  }, [user, graphId]);

  if (!graphId) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Runs</h1>
        <p>Select a graph to see its runs:</p>
        <GraphPicker />
      </div>
    );
  }

  if (loading) return null;
  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <p>
          <a href="/login">Log in</a> to see this graph's runs.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Runs</h1>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th>Status</th>
            <th>Mode</th>
            <th>Started</th>
            <th>Completed</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <td>
                <span style={{ color: STATUS_COLOR[run.status] ?? "var(--text)", fontWeight: 600 }}>{run.status}</span>
              </td>
              <td>{run.mode}</td>
              <td>{new Date(run.createdAt).toLocaleString()}</td>
              <td>{run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}</td>
              <td>
                <a href={`/runs/${run.id}`}>View</a>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5}>No runs yet for this graph.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
