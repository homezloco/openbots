"use client";

import { useEffect, useState } from "react";
import {
  createRun,
  getCommitDiff,
  getPrStatus,
  listCommits,
  openPrForCommit,
  type AgentCommitSummary,
  type PrStatus,
} from "../lib/api";

interface BranchGroup {
  branch: string;
  nodeName: string;
  commits: AgentCommitSummary[];
}

function groupByBranch(commits: AgentCommitSummary[]): BranchGroup[] {
  const groups: BranchGroup[] = [];
  const byBranch = new Map<string, BranchGroup>();
  for (const c of commits) {
    let g = byBranch.get(c.branch);
    if (!g) {
      g = { branch: c.branch, nodeName: c.nodeName, commits: [] };
      byBranch.set(c.branch, g);
      groups.push(g);
    }
    g.commits.push(c);
  }
  return groups;
}

function prColor(state: string) {
  if (state === "merged") return "var(--consensus-edge)";
  if (state === "open") return "var(--success)";
  return "var(--danger)";
}

type DiffState = { diff: string; truncated: boolean } | "loading";

function DiffView({ value }: { value: DiffState }) {
  if (value === "loading") return <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Loading diff…</p>;
  return (
    <div style={{ marginTop: 4, maxHeight: 300, overflow: "auto", background: "var(--bg-elevated)", borderRadius: 4, padding: 8 }}>
      <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
        {value.diff.split("\n").map((line, i) => {
          const added = line.startsWith("+") && !line.startsWith("+++");
          const removed = line.startsWith("-") && !line.startsWith("---");
          return (
            <div key={i} style={{ color: added ? "var(--success)" : removed ? "var(--danger)" : undefined }}>
              {line || " "}
            </div>
          );
        })}
      </pre>
      {value.truncated && <p style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 4 }}>Diff truncated.</p>}
    </div>
  );
}

/**
 * Slide-over covering everything about a graph's git activity — commits
 * grouped by branch, push status, PR status/creation, and per-commit diffs.
 * Replaces the old CommitsPanel (commits-only); same visual pattern as
 * AgentConversationPanel/SchedulesPanel. PR status is fetched live from
 * GitHub, never stored locally (apps/api/src/routes/commits.ts's
 * GET .../pr-status), matching how /pr already checks for an existing PR.
 */
export function GitHubPanel({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const [commits, setCommits] = useState<AgentCommitSummary[] | null>(null);
  const [prStatus, setPrStatus] = useState<Record<string, PrStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [openDiffs, setOpenDiffs] = useState<Record<string, DiffState>>({});

  function refresh() {
    return listCommits(graphId)
      .then(setCommits)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load commits"));
  }

  function refreshPrStatus() {
    getPrStatus(graphId)
      .then((rows) => setPrStatus(Object.fromEntries(rows.map((r) => [r.branch, r]))))
      .catch(() => {
        // Non-fatal — the panel is still useful without PR status.
      });
  }

  useEffect(() => {
    refresh();
    refreshPrStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  async function pushBranch(branch: string) {
    setBusyBranch(branch);
    setError(null);
    setActionResult(null);
    try {
      const run = await createRun(graphId, `/push ${branch}`);
      setActionResult(String(run.output));
      await refresh();
      refreshPrStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to push");
    } finally {
      setBusyBranch(null);
    }
  }

  async function openPr(commitId: string, branch: string) {
    setBusyBranch(branch);
    setError(null);
    setActionResult(null);
    try {
      const res = await openPrForCommit(graphId, commitId);
      setActionResult(res.message);
      refreshPrStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open PR");
    } finally {
      setBusyBranch(null);
    }
  }

  async function toggleDiff(commitId: string) {
    if (openDiffs[commitId]) {
      setOpenDiffs((prev) => {
        const next = { ...prev };
        delete next[commitId];
        return next;
      });
      return;
    }
    setOpenDiffs((prev) => ({ ...prev, [commitId]: "loading" }));
    try {
      const res = await getCommitDiff(graphId, commitId);
      setOpenDiffs((prev) => ({ ...prev, [commitId]: res }));
    } catch (err) {
      setOpenDiffs((prev) => ({
        ...prev,
        [commitId]: { diff: err instanceof Error ? err.message : "Failed to load diff", truncated: false },
      }));
    }
  }

  const groups = commits ? groupByBranch(commits) : [];
  const unpushedCount = commits?.filter((c) => !c.pushedAt).length ?? 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 460,
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
        <strong>🐙 GitHub {commits && `(${unpushedCount} unpushed)`}</strong>
        <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {actionResult && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{actionResult}</p>}

        {commits === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}
        {commits?.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>No commits yet — they appear here once a write-capable agent creates or edits a file.</p>
        )}

        {groups.map((g) => {
          const latest = g.commits[0];
          const pushed = Boolean(latest.pushedAt);
          const status = prStatus[g.branch];
          return (
            <div key={g.branch} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <strong>{g.nodeName}</strong>
                  <p style={{ margin: "4px 0 0", fontFamily: "monospace", fontSize: 13, color: "var(--text-muted)" }}>
                    {g.branch} · {g.commits.length} commit{g.commits.length === 1 ? "" : "s"}
                  </p>
                </div>
                <span style={{ fontSize: 12, color: pushed ? "var(--status-succeeded)" : "var(--text-faint)" }}>
                  {pushed ? "Pushed" : "Unpushed"}
                </span>
              </div>

              {!pushed && (
                <button onClick={() => pushBranch(g.branch)} disabled={busyBranch !== null} style={{ marginTop: 8 }}>
                  {busyBranch === g.branch ? "Pushing…" : "Push this branch"}
                </button>
              )}

              {pushed && status?.pr && (
                <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                  <a href={status.pr.url} target="_blank" rel="noreferrer">
                    #{status.pr.number} {status.pr.title}
                  </a>{" "}
                  <span style={{ color: prColor(status.pr.state) }}>({status.pr.state})</span>
                </p>
              )}
              {pushed && status && !status.pr && status.tokenConfigured && (
                <button onClick={() => openPr(latest.id, g.branch)} disabled={busyBranch !== null} style={{ marginTop: 8 }}>
                  {busyBranch === g.branch ? "Opening…" : "Open PR"}
                </button>
              )}
              {pushed && status && !status.tokenConfigured && (
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-faint)" }}>
                  No GitHub token configured — <a href="/settings">add one</a> to see PR status or open a PR.
                </p>
              )}

              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {g.commits.map((c) => (
                  <div key={c.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>
                        {c.commitSha.slice(0, 8)} — {new Date(c.createdAt).toLocaleString()}
                      </span>
                      <span style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => toggleDiff(c.id)} style={{ fontSize: 12 }}>
                          {openDiffs[c.id] ? "Hide diff" : "View diff"}
                        </button>
                        <a href={`/runs/${c.runId}`} style={{ fontSize: 12 }}>
                          view run
                        </a>
                      </span>
                    </div>
                    {openDiffs[c.id] && <DiffView value={openDiffs[c.id]} />}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
