"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AgentGraph } from "@openbots/graph-schema";
import { fetchGraph } from "../../lib/api";
import { HierarchyCanvas } from "../../components/HierarchyCanvas";
import { GraphPicker } from "../../components/GraphPicker";
import { useAuth } from "../../components/AuthProvider";

/**
 * Client component because GET /graphs/:id requires the session cookie —
 * a server-rendered fetch never carries it (same class of bug as the
 * /runs pages after those endpoints gained requireAuth). useSearchParams()
 * needs a Suspense boundary per Next.js.
 */
export default function HierarchyPage() {
  return (
    <Suspense fallback={null}>
      <HierarchyPageContent />
    </Suspense>
  );
}

function HierarchyPageContent() {
  const graphId = useSearchParams().get("graphId");
  const { user, loading } = useAuth();
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGraph(null);
    setError(null);
    if (!user || !graphId) return;
    fetchGraph(graphId)
      .then(setGraph)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load graph"));
  }, [user, graphId]);

  if (!graphId) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Hierarchy</h1>
        <p>Select a graph to view:</p>
        <GraphPicker />
      </div>
    );
  }

  if (loading) return null;

  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <p>
          <a href="/login">Log in</a> to view this graph.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--danger)" }}>{error}</p>
      </div>
    );
  }

  if (!graph) {
    return (
      <div style={{ padding: 24, color: "var(--text-faint)" }}>
        <p>Loading graph…</p>
      </div>
    );
  }

  // key={graph.id} forces a fresh mount on graph change — HierarchyCanvas
  // seeds its node/edge/graph state from the `graph` prop via
  // useState(initialGraph), which (per React) does NOT re-run on a prop
  // change alone. Without this, navigating between graphs while staying
  // on /hierarchy (e.g. clicking a cross-graph gateway node) updates the
  // URL/searchParams and refetches, but the component instance would
  // otherwise keep rendering the PREVIOUS graph's stale state.
  return <HierarchyCanvas key={graph.id} graph={graph} />;
}
