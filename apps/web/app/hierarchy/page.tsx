import { fetchGraph } from "../../lib/api";
import { HierarchyCanvas } from "../../components/HierarchyCanvas";

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
        <p>
          Pass a graph to view, e.g. <code>/hierarchy?graphId=&lt;uuid&gt;</code>. Create one via{" "}
          <code>POST /graphs</code> on the API.
        </p>
      </div>
    );
  }

  const graph = await fetchGraph(graphId);
  return <HierarchyCanvas graph={graph} />;
}
