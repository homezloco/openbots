"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchRun, type Run, type RunEventRow, type UsageTotal } from "../../../lib/api";
import { useAuth } from "../../../components/AuthProvider";

type RunDetail = Run & { events: RunEventRow[]; usageTotal: UsageTotal };

/**
 * The run replay/audit view: the full ordered hop trail for a run, built
 * directly on the same run_events log that drives the live WebSocket feed
 * during execution — see PLAN.md's "Run replay/audit UI".
 *
 * Client component because GET /runs/:id requires the session cookie —
 * same fix as the runs list page, see the comment there.
 */
export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && id) {
      fetchRun(id).then(setRun).catch((err) => setError(err.message));
    }
  }, [user, id]);

  if (loading) return null;
  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <p>
          <a href="/login">Log in</a> to see this run.
        </p>
      </div>
    );
  }
  if (error) return <div style={{ padding: 24, color: "var(--danger)" }}>{error}</div>;
  if (!run) return null;

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h1>Run {run.id}</h1>
      <p>
        Status: <strong>{run.status}</strong> · Mode: {run.mode} · Started {new Date(run.createdAt).toLocaleString()}
      </p>
      <p>
        Usage: {run.usageTotal.inputTokens} in / {run.usageTotal.outputTokens} out tokens · est. $
        {run.usageTotal.estimatedCostUsd.toFixed(4)}
      </p>

      {run.output != null && (
        <>
          <h2>Final output</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "var(--bg-elevated)", padding: 12, borderRadius: 6 }}>
            {typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2)}
          </pre>
        </>
      )}

      <h2>Event trail</h2>
      <ol style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {run.events.map((event) => (
          <li key={event.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <strong>#{event.sequence}</strong>
              <span>node {event.nodeId}</span>
              <span
                style={{
                  color:
                    event.status === "succeeded"
                      ? "var(--status-succeeded)"
                      : event.status === "failed"
                        ? "var(--status-failed)"
                        : "var(--status-neutral)",
                }}
              >
                {event.status}
              </span>
              {event.fanoutBatchId && <span title="Part of a consensus fan-out">🔀 consensus branch</span>}
            </div>
            {event.output != null && (
              <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
                {typeof event.output === "string" ? event.output : JSON.stringify(event.output, null, 2)}
              </pre>
            )}
            {event.error && <p style={{ color: "var(--danger)", margin: "8px 0 0" }}>{event.error}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
