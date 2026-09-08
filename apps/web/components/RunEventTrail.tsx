import type { RunEventRow } from "../lib/api";

/**
 * The ordered hop-card rendering shared by the run detail page and the
 * per-agent conversation panel — one place to keep in sync with
 * RunEventRow's shape. `nodeNames` resolves a raw nodeId to a readable
 * label (falling back to the id itself for a node that no longer exists,
 * since run_events.nodeId has no FK and outlives a deleted/moved node);
 * `focusNodeId` highlights the row belonging to whichever agent the
 * viewer clicked through from.
 */
export function RunEventTrail({
  events,
  nodeNames,
  focusNodeId,
}: {
  events: RunEventRow[];
  nodeNames?: Record<string, string>;
  focusNodeId?: string;
}) {
  return (
    <ol style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      {events.map((event) => (
        <li
          key={event.id}
          style={{
            border: event.nodeId === focusNodeId ? "2px solid var(--accent)" : "1px solid var(--border)",
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong>#{event.sequence}</strong>
            <span>{nodeNames?.[event.nodeId] ?? `node ${event.nodeId}`}</span>
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
  );
}
