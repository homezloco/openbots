"use client";

import { useEffect, useState } from "react";
import { createRun, listCommits, type AgentCommitSummary } from "../lib/api";

/**
 * Slide-over listing every commit a write-capable agent has made on this
 * graph (apps/api/src/routes/commits.ts) — surfaces "there are N unpushed
 * commits" so the user doesn't have to remember to type /push themselves.
 * Same visual pattern as AgentConversationPanel/SchedulesPanel.
 */
export function CommitsPanel({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const [commits, setCommits] = useState<AgentCommitSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<string | null>(null);

  function refresh() {
    return listCommits(graphId)
      .then(setCommits)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load commits"));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  async function pushBranch(branch: string) {
    setBusyBranch(branch);
    setError(null);
    setPushResult(null);
    try {
      const run = await createRun(graphId, `/push ${branch}`);
      setPushResult(String(run.output));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to push");
    } finally {
      setBusyBranch(null);
    }
  }

  const unpushedCount = commits?.filter((c) => !c.pushedAt).length ?? 0;

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
        <strong>Commits {commits && `(${unpushedCount} unpushed)`}</strong>
        <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {pushResult && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{pushResult}</p>}

        {commits === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}
        {commits?.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>No commits yet — they appear here once a write-capable agent creates or edits a file.</p>
        )}
        {commits?.map((c) => (
          <div key={c.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <strong>{c.nodeName}</strong>
                <p style={{ margin: "4px 0 0", fontFamily: "monospace", fontSize: 13, color: "var(--text-muted)" }}>
                  {c.branch} @ {c.commitSha.slice(0, 8)}
                </p>
              </div>
              <span style={{ fontSize: 12, color: c.pushedAt ? "var(--status-succeeded)" : "var(--text-faint)" }}>
                {c.pushedAt ? "Pushed" : "Unpushed"}
              </span>
            </div>
            <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-muted)" }}>
              Committed {new Date(c.createdAt).toLocaleString()}
              {c.pushedAt && <> — pushed {new Date(c.pushedAt).toLocaleString()}</>}
              {" — "}
              <a href={`/runs/${c.runId}`}>view run</a>
            </p>
            {!c.pushedAt && (
              <button onClick={() => pushBranch(c.branch)} disabled={busyBranch !== null}>
                {busyBranch === c.branch ? "Pushing…" : "Push this branch"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
