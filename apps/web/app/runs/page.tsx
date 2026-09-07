import { listRuns } from "../../lib/api";
import { GraphPicker } from "../../components/GraphPicker";

const STATUS_COLOR: Record<string, string> = {
  running: "#f5a623",
  pending: "#999",
  error: "#e74c3c",
  completed: "#2ecc71",
  cancelled: "#999",
};

/**
 * Companion to the hierarchy canvas: a state-sorted triage list (running
 * first, then everything else by recency) — the API already sorts this
 * way, mirroring Grok Build's dashboard pattern. See PLAN.md.
 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ graphId?: string }>;
}) {
  const { graphId } = await searchParams;

  if (!graphId) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Runs</h1>
        <p>Select a graph to see its runs:</p>
        <GraphPicker />
      </div>
    );
  }

  const runs = await listRuns(graphId);

  return (
    <div style={{ padding: 24 }}>
      <h1>Runs</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th>Status</th>
            <th>Mode</th>
            <th>Started</th>
            <th>Completed</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} style={{ borderBottom: "1px solid #f5f5f5" }}>
              <td>
                <span style={{ color: STATUS_COLOR[run.status] ?? "#333", fontWeight: 600 }}>{run.status}</span>
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
