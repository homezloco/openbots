"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { fetchGraph, fetchRun, type Run, type RunEventRow, type UsageTotal } from "../../../lib/api";
import { useRunEventsSocket } from "../../../lib/useRunEventsSocket";
import { useAuth } from "../../../components/AuthProvider";
import { RunEventTrail } from "../../../components/RunEventTrail";

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
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && id) {
      fetchRun(id).then(setRun).catch((err) => setError(err.message));
    }
  }, [user, id]);

  useEffect(() => {
    if (!run?.graphId) return;
    fetchGraph(run.graphId)
      .then((g) => setNodeNames(Object.fromEntries(g.nodes.map((n) => [n.id, n.name]))))
      .catch(() => {});
  }, [run?.graphId]);

  // Live updates while the run is executing. Refetches rather than
  // hand-building synthetic event rows — reuses 100% of the render code
  // below and avoids inventing a second row shape to keep in sync with
  // RunEventRow. The graph-scoped socket also carries OTHER runs on this
  // graph, hence the explicit msg.runId check.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRunEventsSocket(run?.graphId ?? null, (msg) => {
    if (msg.runId !== id) return;
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      fetchRun(id).then(setRun).catch((err) => setError(err.message));
    }, 200);
  });

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
      <RunEventTrail events={run.events} nodeNames={nodeNames} />
    </div>
  );
}
