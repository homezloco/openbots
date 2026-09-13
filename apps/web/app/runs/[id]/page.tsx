"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchGraph, fetchRun, forkRun, type Run, type RunCommitSummary, type RunEventRow, type UsageTotal } from "../../../lib/api";
import { useRunEventsSocket } from "../../../lib/useRunEventsSocket";
import { stripRoutingSentinel } from "../../../lib/textDisplay";
import { useAuth } from "../../../components/AuthProvider";
import { RunEventTrail } from "../../../components/RunEventTrail";

type RunDetail = Run & { events: RunEventRow[]; usageTotal: UsageTotal; commits: RunCommitSummary[] };

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
  const router = useRouter();
  const { user, loading } = useAuth();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [forkingSequence, setForkingSequence] = useState<number | null>(null);

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
      {run.forkedFromRunId && (
        <p>
          Forked from hop #{run.forkedFromSequence} of{" "}
          <a href={`/runs/${run.forkedFromRunId}`}>run {run.forkedFromRunId.slice(0, 8)}</a>
        </p>
      )}
      <p>
        Usage: {run.usageTotal.inputTokens} in
        {run.usageTotal.cacheReadTokens + run.usageTotal.cacheWriteTokens > 0 && (
          <> ({run.usageTotal.cacheReadTokens} cached, {run.usageTotal.cacheWriteTokens} cache write)</>
        )}{" "}
        / {run.usageTotal.outputTokens} out tokens · est. ${run.usageTotal.estimatedCostUsd.toFixed(4)}
      </p>

      {run.commits && run.commits.length > 0 && (
        <div
          style={{
            background: run.status === "error" ? "var(--danger-bg, #3a1f1f)" : "var(--bg-elevated)",
            border: run.status === "error" ? "1px solid var(--danger)" : "1px solid var(--border)",
            borderRadius: 6,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <h2 style={{ marginTop: 0 }}>Committed work</h2>
          {run.status === "error" && (
            <p>
              This run failed, but the work below survives on its branch — nothing was lost. Push it (or open a PR)
              from the GitHub panel on the Hierarchy canvas.
            </p>
          )}
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {run.commits.map((c) => (
              <li key={c.id}>
                <code>{c.branch}</code> @ <code>{c.commitSha.slice(0, 7)}</code> —{" "}
                {c.pushedAt ? "pushed" : "not yet pushed"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(() => {
        // run.input is a scratch field the engine overwrites on every hop
        // transition — by completion it holds the LAST hop's input, not
        // what was actually asked. The true original request is only
        // ever written once, at sequence 0 (same fix the runs-list
        // endpoint already applies server-side; done client-side here
        // since GET /runs/:id doesn't need a second field for it).
        const original = run.events.find((e) => e.sequence === 0)?.input;
        if (original == null) return null;
        return (
          <>
            <h2>Original request</h2>
            <pre style={{ whiteSpace: "pre-wrap", background: "var(--bg-elevated)", padding: 12, borderRadius: 6 }}>
              {typeof original === "string" ? original : JSON.stringify(original, null, 2)}
            </pre>
          </>
        );
      })()}

      {run.output != null && (
        <>
          <h2>Final output</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "var(--bg-elevated)", padding: 12, borderRadius: 6 }}>
            {typeof run.output === "string" ? stripRoutingSentinel(run.output) : JSON.stringify(run.output, null, 2)}
          </pre>
        </>
      )}

      <h2>Event trail</h2>
      <RunEventTrail
        events={run.events}
        nodeNames={nodeNames}
        forkingSequence={forkingSequence}
        onFork={async (sequence) => {
          setForkingSequence(sequence);
          setError(null);
          try {
            const fork = await forkRun(run.graphId, run.id, sequence);
            router.push(`/runs/${fork.id}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Fork failed");
            setForkingSequence(null);
          }
        }}
      />
    </div>
  );
}
