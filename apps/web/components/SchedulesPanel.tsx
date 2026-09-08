"use client";

import { useEffect, useState } from "react";
import { createSchedule, deleteSchedule, listSchedules, listScheduleRuns, updateSchedule, type ScheduledTrigger, type ScheduleRunSummary } from "../lib/api";

/**
 * Slide-over for a graph's recurring cron schedules (apps/api/src/routes/
 * scheduledTriggers.ts) — same visual pattern as AgentConversationPanel.
 * A schedule just runs the graph with a fixed input on a cron pattern; the
 * resulting run shows up in the graph's normal run history like any other.
 */
export function SchedulesPanel({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const [schedules, setSchedules] = useState<ScheduledTrigger[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [mode, setMode] = useState<"pinned" | "live">("pinned");

  function refresh() {
    return listSchedules(graphId)
      .then(setSchedules)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load schedules"));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  async function create() {
    if (!name.trim() || !input.trim() || !cronExpression.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createSchedule(graphId, { name: name.trim(), input: input.trim(), cronExpression: cronExpression.trim(), mode });
      await refresh();
      setName("");
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(schedule: ScheduledTrigger) {
    setBusy(true);
    setError(null);
    try {
      await updateSchedule(graphId, schedule.id, { enabled: !schedule.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteSchedule(graphId, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
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
        <strong>Schedules</strong>
        <button onClick={onClose} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Name</span>
            <input placeholder="e.g. Daily status check" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Message to send</span>
            <textarea rows={3} placeholder="What should the team do?" value={input} onChange={(e) => setInput(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Cron expression <span style={{ color: "var(--text-faint)" }}>(UTC, 5-field — e.g. &quot;0 9 * * *&quot; = 9am daily)</span>
            </span>
            <input value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} style={{ fontFamily: "monospace" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Run mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "pinned" | "live")}>
              <option value="pinned">Pinned (graph snapshot at run time)</option>
              <option value="live">Live (re-resolves routing on every hop)</option>
            </select>
          </label>
          <button onClick={create} disabled={busy || !name.trim() || !input.trim() || !cronExpression.trim()} style={{ alignSelf: "flex-start" }}>
            Add schedule
          </button>
        </div>

        {schedules === null && <p style={{ color: "var(--text-faint)" }}>Loading…</p>}
        {schedules?.length === 0 && <p style={{ color: "var(--text-faint)" }}>No schedules yet.</p>}
        {schedules?.map((s) => (
          <ScheduleCard key={s.id} graphId={graphId} schedule={s} busy={busy} onToggle={() => toggleEnabled(s)} onDelete={() => remove(s.id)} />
        ))}
      </div>
    </div>
  );
}

function ScheduleCard({
  graphId,
  schedule: s,
  busy,
  onToggle,
  onDelete,
}: {
  graphId: string;
  schedule: ScheduledTrigger;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ScheduleRunSummary[] | null>(null);

  function toggleHistory() {
    setShowHistory((v) => !v);
    if (!history) listScheduleRuns(graphId, s.id).then(setHistory).catch(() => setHistory([]));
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong>{s.name}</strong>
          <p style={{ margin: "4px 0 0", fontFamily: "monospace", fontSize: 13, color: "var(--text-muted)" }}>{s.cronExpression}</p>
        </div>
        <span style={{ fontSize: 12, color: s.enabled ? "var(--status-succeeded)" : "var(--text-faint)" }}>
          {s.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-muted)" }}>
        {s.lastTriggeredAt ? (
          <>
            Last ran {new Date(s.lastTriggeredAt).toLocaleString()}
            {s.lastRunId && (
              <>
                {" — "}
                <a href={`/runs/${s.lastRunId}`}>view run</a>
              </>
            )}
          </>
        ) : (
          "Never triggered yet"
        )}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onToggle} disabled={busy}>
          {s.enabled ? "Disable" : "Enable"}
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
