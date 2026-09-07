import { fetchRun } from "../../../lib/api";

/**
 * The run replay/audit view: the full ordered hop trail for a run, built
 * directly on the same run_events log that drives the live WebSocket feed
 * during execution — see PLAN.md's "Run replay/audit UI".
 */
export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await fetchRun(id);

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
          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 6 }}>
            {typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2)}
          </pre>
        </>
      )}

      <h2>Event trail</h2>
      <ol style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {run.events.map((event) => (
          <li key={event.id} style={{ border: "1px solid #eee", borderRadius: 6, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <strong>#{event.sequence}</strong>
              <span>node {event.nodeId}</span>
              <span
                style={{
                  color: event.status === "succeeded" ? "#2ecc71" : event.status === "failed" ? "#e74c3c" : "#999",
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
            {event.error && <p style={{ color: "#e74c3c", margin: "8px 0 0" }}>{event.error}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
