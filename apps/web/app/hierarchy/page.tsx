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
  return <HierarchyCanvas graph={graph} />;
}
