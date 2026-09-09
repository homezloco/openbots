import { fetchGraph } from "../../lib/api";
import { HierarchyCanvas } from "../../components/HierarchyCanvas";
import { GraphPicker } from "../../components/GraphPicker";

export default async function HierarchyPage({
  searchParams,
}: {
  searchParams: Promise<{ graphId?: string }>;
}) {
  const { graphId } = await searchParams;

  if (!graphId) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Hierarchy</h1>
        <p>Select a graph to view:</p>
        <GraphPicker />
      </div>
    );
  }

  const graph = await fetchGraph(graphId);
  // key={graph.id} forces a fresh mount on graph change — HierarchyCanvas
  // seeds its node/edge/graph state from the `graph` prop via
  // useState(initialGraph), which (per React) does NOT re-run on a prop
  // change alone. Without this, navigating between graphs while staying
  // on /hierarchy (e.g. clicking a cross-graph gateway node) updates the
  // URL/searchParams and refetches server-side, but the client component
  // instance survives and keeps rendering the PREVIOUS graph's stale state.
  return <HierarchyCanvas key={graph.id} graph={graph} />;
}
