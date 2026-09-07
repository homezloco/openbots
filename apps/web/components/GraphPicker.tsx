"use client";

import { useEffect, useState } from "react";
import { listGraphs, type GraphSummary } from "../lib/api";
import { useAuth } from "./AuthProvider";

/**
 * Shown on /hierarchy when no graphId is given — lets you pick from your
 * existing graphs instead of needing to already know a graph's id. Reads
 * the roster client-side because listGraphs() requires the session cookie,
 * which a server component page can't forward the way a browser fetch
 * does automatically.
 */
export function GraphPicker() {
  const { user, loading } = useAuth();
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) listGraphs().then(setGraphs).catch((err) => setError(err.message));
  }, [user]);

  if (loading) return null;
  if (!user) {
    return (
      <p>
        <a href="/login">Log in</a> to see your graphs.
      </p>
    );
  }

  return (
    <div>
      {error && <p style={{ color: "#e74c3c" }}>{error}</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {graphs.map((g) => (
          <li key={g.id}>
            <a href={`/hierarchy?graphId=${g.id}`}>{g.name}</a>{" "}
            <small style={{ color: "#999" }}>
              ({g.nodeCount} agent{g.nodeCount === 1 ? "" : "s"})
            </small>
          </li>
        ))}
        {graphs.length === 0 && <p style={{ color: "#999" }}>No graphs yet.</p>}
      </ul>
      <a href="/graphs/new">+ New graph</a>
    </div>
  );
}
