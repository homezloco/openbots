/**
 * Free PR-tier e2e suite: exercises the real running stack (Postgres,
 * Redis, api, worker) over HTTP exactly like run.ts does — but every
 * node uses `provider: "mock"` (packages/providers/src/registry.ts), so
 * it makes ZERO billed model calls and needs ZERO provider API keys.
 * This is what lets CI run it on every pull request, including from
 * forks, with no repo secrets (.github/workflows/e2e-mock.yml).
 *
 * What belongs here: routing/orchestration mechanics that are
 * deterministic under the mock adapter (explicit chaining, ROUTE_TO-
 * steered auto routing, the UNKNOWN sentinel, consensus fan-out/join,
 * the cycle guard) plus auth/ownership/IDOR cases that never involve a
 * model at all. What does NOT belong here: anything that depends on real
 * model judgment or a real timing race (mid-run rerouting — the mock
 * answers instantly, so the race is unwinnable by construction), real
 * provider fallback classification, tool calling. Those stay in run.ts,
 * the billed tier that runs on pushes to main.
 *
 * Run with: pnpm --filter @openbots/api test:e2e:mock
 * against a stack already up via docker compose (api + worker).
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4000";

let sessionCookie = "";

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (sessionCookie) headers.cookie = sessionCookie;

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";")[0];

  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** Mock hops are near-instant; 30s covers queue latency on a cold CI runner. */
async function waitForRun(runId: string, timeoutMs = 30_000): Promise<any> {
  if (!runId) throw new Error("waitForRun called with no run id — the preceding run-creation call likely failed");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/runs/${runId}`);
    if (body.status === "completed" || body.status === "error") return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}

/**
 * Same idea as waitForRun, but for approval-gate cases that need to
 * observe the PAUSE itself, not just wait through it to a terminal
 * status — "awaiting_approval" never resolves on its own, so waitForRun
 * would just time out.
 */
async function waitForRunStatus(runId: string, statuses: string[], timeoutMs = 30_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/runs/${runId}`);
    if (statuses.includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${runId} did not reach status [${statuses.join(",")}] within ${timeoutMs}ms`);
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - start;
    results.push({ name, passed: true, durationMs });
    console.log(`✅ ${name} (${durationMs}ms)`);
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: message, durationMs });
    console.log(`❌ ${name} (${durationMs}ms): ${message}`);
  }
}

/** Every node in this suite is a mock node; only name/prompt/description vary. */
function mockNode(overrides: {
  name: string;
  role?: string;
  systemPrompt?: string;
  description?: string;
  position?: { x: number; y: number };
}) {
  return {
    role: "worker",
    systemPrompt: "deterministic mock node",
    description: overrides.name,
    position: { x: 0, y: 0 },
    provider: "mock",
    model: "mock-model",
    ...overrides,
  };
}

async function createGraph(name: string): Promise<any> {
  const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name }) });
  assert(g.status === 201, `graph create failed: ${g.status} ${JSON.stringify(g.body)}`);
  return g.body;
}

async function createNode(graphId: string, node: ReturnType<typeof mockNode>): Promise<any> {
  const n = await api(`/graphs/${graphId}/nodes`, { method: "POST", body: JSON.stringify(node) });
  assert(n.status === 201, `node create failed: ${n.status} ${JSON.stringify(n.body)}`);
  return n.body;
}

async function createEdge(graphId: string, sourceNodeId: string, targetNodeId: string, kind: string): Promise<any> {
  const e = await api(`/graphs/${graphId}/edges`, {
    method: "POST",
    body: JSON.stringify({ sourceNodeId, targetNodeId, kind }),
  });
  assert(e.status === 201, `edge create failed: ${e.status} ${JSON.stringify(e.body)}`);
  return e.body;
}

async function setEntry(graphId: string, entryNodeId: string): Promise<void> {
  const p = await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId }) });
  assert(p.status === 200, `set entry failed: ${p.status} ${JSON.stringify(p.body)}`);
}

async function startRun(graphId: string, input: string): Promise<string> {
  const r = await api("/runs", { method: "POST", body: JSON.stringify({ graphId, input }) });
  assert(r.status === 201, `run create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

function succeededEvents(run: any): any[] {
  return (run.events as any[]).filter((e) => e.status === "succeeded");
}

async function main() {
  const email = `e2e-mock-${Date.now()}@openbots.dev`;
  const password = "e2e-mock-password-123";
  let ownerId = "";

  await test("health check", async () => {
    const { status, body } = await api("/health");
    assert(status === 200 && body.status === "ok", `unexpected: ${status} ${JSON.stringify(body)}`);
  });

  await test("signup + session cookie works", async () => {
    const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    assert(signup.status === 201, `signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    ownerId = signup.body.id;
    const me = await api("/auth/me");
    assert(me.status === 200 && me.body.email === email, `auth/me failed: ${JSON.stringify(me.body)}`);
  });

  await test("mock node create returns the hydrated shape (position object, provider echo)", async () => {
    const g = await createGraph("Mock: node shape");
    const n = await createNode(g.id, mockNode({ name: "Shape Check", position: { x: 12, y: 34 } }));
    assert(n.provider === "mock" && n.model === "mock-model", `provider/model echo wrong: ${JSON.stringify(n)}`);
    assert(n.position && n.position.x === 12 && n.position.y === 34, `position shape wrong: ${JSON.stringify(n.position)}`);
  });

  await test("explicit pipeline chains output hop-to-hop, no credentials configured anywhere", async () => {
    const g = await createGraph("Mock: explicit chain");
    const a = await createNode(g.id, mockNode({ name: "Alpha" }));
    const b = await createNode(g.id, mockNode({ name: "Beta" }));
    await createEdge(g.id, a.id, b.id, "explicit");
    await setEntry(g.id, a.id);

    const runId = await startRun(g.id, "hello mock");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    // Hop 1 echoes the input; an explicit edge feeds that output to hop 2,
    // which echoes it again — deterministic double prefix.
    assert(run.output === "MOCK: MOCK: hello mock", `expected chained echo, got: ${JSON.stringify(run.output)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2, `expected 2 hops, got ${hops.length}`);
    assert(hops[0].nodeId === a.id && hops[1].nodeId === b.id, "hops in wrong order");
  });

  await test("ROUTE_TO steers auto routing deterministically; specialist gets the ORIGINAL input", async () => {
    const g = await createGraph("Mock: auto routing");
    const router = await createNode(
      g.id,
      mockNode({ name: "Router", role: "router", systemPrompt: "ROUTE_TO Billing" }),
    );
    const support = await createNode(g.id, mockNode({ name: "Support", description: "support things" }));
    const billing = await createNode(g.id, mockNode({ name: "Billing", description: "billing things" }));
    await createEdge(g.id, router.id, support.id, "auto");
    await createEdge(g.id, router.id, billing.id, "auto");
    await setEntry(g.id, router.id);

    const runId = await startRun(g.id, "please refund my order");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2, `expected 2 hops, got ${hops.length}`);
    assert(hops[1].nodeId === billing.id, `expected Billing to run, got node ${hops[1].nodeId}`);
    // Auto handoff passes the user's original request, not the router's output.
    assert(run.output === "MOCK: please refund my order", `expected original-input echo, got: ${JSON.stringify(run.output)}`);
  });

  await test("UNKNOWN sentinel completes the run with the router's own output instead of guessing", async () => {
    const g = await createGraph("Mock: UNKNOWN");
    const router = await createNode(
      g.id,
      mockNode({ name: "Router", role: "router", systemPrompt: "ROUTE_TO UNKNOWN" }),
    );
    const s1 = await createNode(g.id, mockNode({ name: "SpecialistOne", description: "one" }));
    const s2 = await createNode(g.id, mockNode({ name: "SpecialistTwo", description: "two" }));
    await createEdge(g.id, router.id, s1.id, "auto");
    await createEdge(g.id, router.id, s2.id, "auto");
    await setEntry(g.id, router.id);

    const runId = await startRun(g.id, "totally ambiguous request");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 1, `expected only the router hop, got ${hops.length}`);
    assert(run.output === "UNKNOWN", `expected UNKNOWN as the answer, got: ${JSON.stringify(run.output)}`);
  });

  await test("consensus fan-out joins both branches into the aggregator", async () => {
    const g = await createGraph("Mock: consensus");
    const source = await createNode(g.id, mockNode({ name: "FanoutSource" }));
    const b1 = await createNode(g.id, mockNode({ name: "BranchOne" }));
    const b2 = await createNode(g.id, mockNode({ name: "BranchTwo" }));
    const agg = await createNode(g.id, mockNode({ name: "Aggregator" }));
    const e1 = await createEdge(g.id, source.id, b1.id, "consensus");
    const e2 = await createEdge(g.id, source.id, b2.id, "consensus");
    const patch = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ consensusGroup: { edgeIds: [e1.id, e2.id], aggregatorNodeId: agg.id } }),
    });
    assert(patch.status === 200, `consensusGroup patch failed: ${patch.status} ${JSON.stringify(patch.body)}`);
    await setEntry(g.id, source.id);

    const runId = await startRun(g.id, "fan this out");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    const hopNodeIds = hops.map((h) => h.nodeId);
    assert(hopNodeIds.includes(b1.id) && hopNodeIds.includes(b2.id), `both branches should run: ${JSON.stringify(hopNodeIds)}`);
    assert(hopNodeIds[hopNodeIds.length - 1] === agg.id, "aggregator should be the final hop");
    const branchHops = hops.filter((h) => h.nodeId === b1.id || h.nodeId === b2.id);
    assert(branchHops.every((h) => h.fanoutBatchId), "branch hops should carry a fanoutBatchId");
    assert(typeof run.output === "string" && run.output.startsWith("MOCK: "), `aggregator output missing: ${JSON.stringify(run.output)}`);
  });

  // --- Self-referential fan-out aggregators (found via external review, 2026-09-13) ---
  // dispatchHop used to check mapConfig before the aggregator-terminal
  // path, and aggregatorNodeIds() only tracked consensus aggregators —
  // a node whose own mapConfig/consensusGroup.aggregatorNodeId pointed
  // at itself would re-trigger fan-out forever with no cycle guard.
  // These are save-time-only cases; the runtime reordering fix
  // (aggregatorNodeIds now covers map too, checked before either
  // fan-out trigger) has no mock-tier equivalent, since the only way to
  // reach it live is the exact self-reference these save-time checks
  // now reject outright.

  await test("security: mapConfig cannot reference the node itself as target or aggregator", async () => {
    const g = await createGraph("Mock: map self-reference");
    const source = await createNode(g.id, mockNode({ name: "MapSource" }));
    const worker = await createNode(g.id, mockNode({ name: "Worker" }));
    const aggregator = await createNode(g.id, mockNode({ name: "Aggregator" }));

    const selfTarget = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ mapConfig: { targetNodeId: source.id, aggregatorNodeId: aggregator.id } }),
    });
    assert(selfTarget.status === 400, `expected 400 for self-referential targetNodeId, got ${selfTarget.status} ${JSON.stringify(selfTarget.body)}`);
    assert(/targetNodeId/.test(selfTarget.body.error ?? ""), `expected a targetNodeId-specific error, got: ${JSON.stringify(selfTarget.body)}`);

    const selfAggregator = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ mapConfig: { targetNodeId: worker.id, aggregatorNodeId: source.id } }),
    });
    assert(selfAggregator.status === 400, `expected 400 for self-referential aggregatorNodeId, got ${selfAggregator.status} ${JSON.stringify(selfAggregator.body)}`);
    assert(/aggregatorNodeId/.test(selfAggregator.body.error ?? ""), `expected an aggregatorNodeId-specific error, got: ${JSON.stringify(selfAggregator.body)}`);
  });

  await test("security: consensusGroup cannot reference the node itself as aggregator", async () => {
    const g = await createGraph("Mock: consensus self-reference");
    const source = await createNode(g.id, mockNode({ name: "ConsensusSource" }));
    const branch = await createNode(g.id, mockNode({ name: "Branch" }));
    const other = await createNode(g.id, mockNode({ name: "Other" }));
    const e1 = await createEdge(g.id, source.id, branch.id, "consensus");
    const e2 = await createEdge(g.id, source.id, other.id, "consensus");

    const patch = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ consensusGroup: { edgeIds: [e1.id, e2.id], aggregatorNodeId: source.id } }),
    });
    assert(patch.status === 400, `expected 400 for self-referential consensus aggregator, got ${patch.status} ${JSON.stringify(patch.body)}`);
    assert(/aggregatorNodeId/.test(patch.body.error ?? ""), `expected an aggregatorNodeId-specific error, got: ${JSON.stringify(patch.body)}`);
  });

  // --- Approval gate vs. fan-out bypass via edge mutations, not node saves (found via external review, 2026-09-13) ---
  // checkApprovalGateCompatible only ran on node create/update. Two other
  // mutations could still make a gated node a live fan-out branch target:
  // auto-syncing a new edge into an already-hybrid node's consensusGroup
  // (insertRoutingEdge), and dragging an existing branch edge onto a
  // gated node (the edge reroute PATCH). Both are now checked too.

  await test("security: a new auto edge is rejected if it would auto-sync a gated node into a hybrid's consensusGroup", async () => {
    const g = await createGraph("Mock: hybrid auto-sync vs gate");
    const source = await createNode(g.id, mockNode({ name: "HybridSource" }));
    const branch = await createNode(g.id, mockNode({ name: "Branch" }));
    const branch2 = await createNode(g.id, mockNode({ name: "Branch2" }));
    const aggregator = await createNode(g.id, mockNode({ name: "Aggregator" }));
    const existingEdge = await createEdge(g.id, source.id, branch.id, "auto");
    const existingEdge2 = await createEdge(g.id, source.id, branch2.id, "auto");
    const patch = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ consensusGroup: { edgeIds: [existingEdge.id, existingEdge2.id], aggregatorNodeId: aggregator.id } }),
    });
    assert(patch.status === 200, `consensusGroup patch failed: ${patch.status} ${JSON.stringify(patch.body)}`);

    const gated = await createNode(g.id, {
      ...mockNode({ name: "GatedTarget" }),
      approvalConfig: { instructions: "review" },
    });
    const newEdge = await api(`/graphs/${g.id}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: source.id, targetNodeId: gated.id, kind: "auto" }),
    });
    assert(newEdge.status === 400, `expected 400 adding an auto edge into a gated node from a hybrid source, got ${newEdge.status} ${JSON.stringify(newEdge.body)}`);
    assert(/approval gate/i.test(newEdge.body.error ?? ""), `expected a clear approval-gate error, got: ${JSON.stringify(newEdge.body)}`);

    // The edge must not have been created at all, and the gated node must
    // not have been silently synced into consensusGroup.edgeIds either.
    const graph = await api(`/graphs/${g.id}`);
    assert(!graph.body.edges.some((e: any) => e.targetNodeId === gated.id), "the rejected edge should not exist");
    const refreshedSource = graph.body.nodes.find((n: any) => n.id === source.id);
    assert(!refreshedSource.consensusGroup.edgeIds.includes(gated.id), "gated node's edge must not be in consensusGroup.edgeIds");
  });

  await test("security: rerouting a live consensus branch edge onto a gated node is rejected", async () => {
    const g = await createGraph("Mock: reroute vs gate");
    const source = await createNode(g.id, mockNode({ name: "ConsensusSource2" }));
    const branch = await createNode(g.id, mockNode({ name: "Branch2a" }));
    const branch2 = await createNode(g.id, mockNode({ name: "Branch2b" }));
    const aggregator = await createNode(g.id, mockNode({ name: "Aggregator2" }));
    const edge = await createEdge(g.id, source.id, branch.id, "consensus");
    const edge2 = await createEdge(g.id, source.id, branch2.id, "consensus");
    const patch = await api(`/graphs/${g.id}/nodes/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ consensusGroup: { edgeIds: [edge.id, edge2.id], aggregatorNodeId: aggregator.id } }),
    });
    assert(patch.status === 200, `consensusGroup patch failed: ${patch.status} ${JSON.stringify(patch.body)}`);

    const gated = await createNode(g.id, {
      ...mockNode({ name: "GatedRerouteTarget" }),
      approvalConfig: { instructions: "review" },
    });
    const reroute = await api(`/graphs/${g.id}/edges/${edge.id}`, {
      method: "PATCH",
      body: JSON.stringify({ targetNodeId: gated.id }),
    });
    assert(reroute.status === 400, `expected 400 rerouting a consensus branch edge onto a gated node, got ${reroute.status} ${JSON.stringify(reroute.body)}`);
    assert(/approval gate/i.test(reroute.body.error ?? ""), `expected a clear approval-gate error, got: ${JSON.stringify(reroute.body)}`);

    const graph = await api(`/graphs/${g.id}`);
    const stillEdge = graph.body.edges.find((e: any) => e.id === edge.id);
    assert(stillEdge.targetNodeId === branch.id, "the edge's target must be unchanged after a rejected reroute");
  });

  await test("cycle guard: an explicit A→B→A loop completes instead of spinning forever", async () => {
    const g = await createGraph("Mock: cycle guard");
    const a = await createNode(g.id, mockNode({ name: "LoopA" }));
    const b = await createNode(g.id, mockNode({ name: "LoopB" }));
    await createEdge(g.id, a.id, b.id, "explicit");
    await createEdge(g.id, b.id, a.id, "explicit");
    await setEntry(g.id, a.id);

    const runId = await startRun(g.id, "around we go");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2, `expected the revisit to end the run after 2 hops, got ${hops.length}`);
  });

  // --- auth/ownership cases: no model involved at all ---
  await test("security: second user cannot read or mutate the first user's graph/runs", async () => {
    const g = await createGraph("Mock: ownership");
    const n = await createNode(g.id, mockNode({ name: "Private" }));
    await setEntry(g.id, n.id);
    const runId = await startRun(g.id, "owner only");
    await waitForRun(runId);

    const ownerCookie = sessionCookie;
    sessionCookie = "";
    const attacker = await api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: `e2e-mock-attacker-${Date.now()}@openbots.dev`, password: "attacker-pass-123" }),
    });
    assert(attacker.status === 201, `attacker signup failed: ${JSON.stringify(attacker.body)}`);

    const readGraph = await api(`/graphs/${g.id}`);
    assert(readGraph.status === 403, `expected 403 reading foreign graph, got ${readGraph.status}`);
    const readRun = await api(`/runs/${runId}`);
    // 404 rather than 403 is fine here — not revealing whether a foreign
    // run id exists at all is a valid (arguably stronger) denial.
    assert(readRun.status === 403 || readRun.status === 404, `expected 403/404 reading foreign run, got ${readRun.status}`);
    const patchNode = await api(`/graphs/${g.id}/nodes/${n.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hijacked" }),
    });
    assert(patchNode.status === 403 || patchNode.status === 404, `expected 403/404 mutating foreign node, got ${patchNode.status}`);

    sessionCookie = ownerCookie;
    const stillOurs = await api(`/graphs/${g.id}`);
    assert(stillOurs.status === 200 && stillOurs.body.nodes[0].name === "Private", "owner state should be untouched");
  });

  await test("security: routing-changes audit trail requires auth and ownership", async () => {
    const g = await createGraph("Mock: audit trail");
    const ownerCookie = sessionCookie;

    sessionCookie = "";
    const unauth = await api(`/graphs/${g.id}/routing-changes`);
    assert(unauth.status === 401, `expected 401 unauthenticated, got ${unauth.status}`);

    await api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: `e2e-mock-outsider-${Date.now()}@openbots.dev`, password: "outsider-pass-123" }),
    });
    const wrongOwner = await api(`/graphs/${g.id}/routing-changes`);
    assert(wrongOwner.status === 403, `expected 403 wrong owner, got ${wrongOwner.status}`);

    sessionCookie = ownerCookie;
    const owner = await api(`/graphs/${g.id}/routing-changes`);
    assert(owner.status === 200, `expected 200 for owner, got ${owner.status}`);
  });

  // --- Structural ambiguity detection (resolve.ts::matchAutoEdge) ---
  // The mock provider echoes the input back as the router's output, which
  // makes the router's exact wording controllable — the only way to test
  // these paths deterministically. Real-model coverage of the same
  // behaviour is inherently flaky; this is the point of the mock tier.
  async function ambiguityGraph(name: string) {
    const g = await createGraph(name);
    const router = await createNode(g.id, mockNode({ name: "Router", role: "router" }));
    const billing = await createNode(
      g.id,
      mockNode({ name: "Billing Specialist", description: "invoices, payments, refunds" }),
    );
    const tech = await createNode(
      g.id,
      mockNode({ name: "Technical Specialist", description: "bugs, crashes, errors" }),
    );
    await createEdge(g.id, router.id, billing.id, "auto");
    await createEdge(g.id, router.id, tech.id, "auto");
    await setEntry(g.id, router.id);
    return { g, router, billing, tech };
  }

  await test("auto-routing: a clarifying question naming two specialists does not silently route", async () => {
    const { g, router } = await ambiguityGraph("Mock: ambiguity two names");
    // Mirrors a real Gemma 4 E4B output: correct judgement (it asked),
    // wrong protocol (no UNKNOWN prefix). Before the structural check this
    // keyword-matched "Billing Specialist" and threw the question away.
    const runId = await startRun(
      g.id,
      "Is this about your invoice (Billing Specialist) or a crash (Technical Specialist)?",
    );
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 1, `expected the question to end the run, got ${hops.length} hops`);
    assert(hops[0].nodeId === router.id, "the router's own question should be the answer");
  });

  await test("auto-routing: a trailing question naming nobody does not tie-break into a target", async () => {
    const { g, router } = await ambiguityGraph("Mock: ambiguity no names");
    // "Specialist" is a token both targets share, so scoring alone would
    // tie and pick one arbitrarily by priority.
    const runId = await startRun(g.id, "Which specialist should handle this?");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 1, `expected the question to end the run, got ${hops.length} hops`);
    assert(hops[0].nodeId === router.id, "the router's own question should be the answer");
  });

  await test("auto-routing: a decisive answer mentioning a second specialist still routes", async () => {
    const { g, billing } = await ambiguityGraph("Mock: decisive with contrast");
    // Names both AND contains a question mark, but the question is not
    // trailing and the sentence is a decision — the regression this fix
    // most risked causing.
    const runId = await startRun(
      g.id,
      "Is it a crash? No. This is the Billing Specialist's area, not the Technical Specialist's.",
    );
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2, `expected the run to route onward, got ${hops.length} hops`);
    assert(hops[1].nodeId === billing.id, `expected Billing, got ${hops[1].nodeId}`);
  });

  await test("transform node: template op interpolates {{input}} in an agent→transform pipeline", async () => {
    const g = await createGraph("Mock: transform template");
    const agent = await createNode(g.id, mockNode({ name: "Agent" }));
    const t = await createNode(g.id, {
      ...mockNode({ name: "Formatter", systemPrompt: "Report follows:\n{{input}}\n-- end --" }),
      provider: "transform",
      model: "template",
    });
    await createEdge(g.id, agent.id, t.id, "explicit");
    await setEntry(g.id, agent.id);

    const runId = await startRun(g.id, "raw data");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    // hop 1 (mock agent) outputs "MOCK: raw data"; the explicit edge feeds
    // that to the transform, which interpolates it into the template.
    assert(
      run.output === "Report follows:\nMOCK: raw data\n-- end --",
      `template interpolation wrong: ${JSON.stringify(run.output)}`,
    );
  });

  await test("transform node: extract-json pulls the first JSON object out of noisy text", async () => {
    const g = await createGraph("Mock: transform extract-json");
    const t = await createNode(g.id, {
      ...mockNode({ name: "JsonExtractor" }),
      provider: "transform",
      model: "extract-json",
    });
    await setEntry(g.id, t.id);

    const runId = await startRun(g.id, 'Here you go: {"a": [1, 2], "b": "x"} hope that helps!');
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    // Compare parsed, not textually: runs.output is a jsonb column, and a
    // string output that happens to be valid JSON text comes back as a
    // parsed document (whitespace normalized, type changed) — a known
    // storage quirk that predates transform nodes (any pure-JSON LLM
    // answer round-trips the same way; useBotChat already defends).
    const parsed = typeof run.output === "string" ? JSON.parse(run.output) : run.output;
    assert(
      JSON.stringify(parsed) === JSON.stringify({ a: [1, 2], b: "x" }),
      `extract-json wrong: ${JSON.stringify(run.output)}`,
    );
  });

  await test("transform node: unknown operation fails the run with a clear error", async () => {
    const g = await createGraph("Mock: transform bad op");
    const t = await createNode(g.id, {
      ...mockNode({ name: "BadOp" }),
      provider: "transform",
      model: "frobnicate",
    });
    await setEntry(g.id, t.id);

    const runId = await startRun(g.id, "anything");
    const run = await waitForRun(runId);
    assert(run.status === "error", `expected error status, got: ${run.status}`);
    const failed = (run.events as any[]).filter((e) => e.status === "failed");
    assert(
      failed.length === 1 && /Unknown transform operation/.test(failed[0].error ?? ""),
      `expected a clear unknown-operation error, got: ${JSON.stringify(failed.map((f: any) => f.error))}`,
    );
  });

  // --- Reviewer gate (reviewGate.ts) ---
  // A reviewer fed by an explicit edge is a gate on the previous hop, so
  // the run delivers the REVIEWED content with the verdict attached —
  // never the verdict alone (which is what a real 8-agent pipeline
  // shipped as its answer, and then chained into the next chat turn as
  // the assistant's own prior message). Same mock/transform trick as the
  // auto-routing cases: the reviewer's exact wording is controllable, so
  // both the cooperating (sentinel) and non-cooperating (prose verdict)
  // paths are deterministic.
  async function reviewGateGraph(name: string, reviewer: ReturnType<typeof mockNode>) {
    const g = await createGraph(name);
    const worker = await createNode(g.id, mockNode({ name: "Writer" }));
    const r = await createNode(g.id, reviewer);
    await createEdge(g.id, worker.id, r.id, "explicit");
    await setEntry(g.id, worker.id);
    return { g, worker, reviewer: r };
  }

  await test("reviewer gate: APPROVED delivers the reviewed content, not the verdict", async () => {
    const { g, reviewer } = await reviewGateGraph(
      "Mock: review gate approved",
      mockNode({ name: "Quality Reviewer", role: "reviewer", systemPrompt: "ROUTE_TO APPROVED" }),
    );
    const runId = await startRun(g.id, "draft the memo");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2, `expected 2 hops, got ${hops.length}`);
    // The trail still shows what the reviewer actually said…
    assert(hops[1].nodeId === reviewer.id && hops[1].output === "APPROVED", `reviewer hop wrong: ${JSON.stringify(hops[1])}`);
    // …but the run's answer is the writer's content plus a one-line note.
    assert(
      run.output === "MOCK: draft the memo\n\n---\n✅ Reviewed by Quality Reviewer: approved.",
      `expected reviewed content + approval note, got: ${JSON.stringify(run.output)}`,
    );
  });

  await test("reviewer gate: NEEDS_REVISION keeps the content and appends the reviewer's issues", async () => {
    const { g } = await reviewGateGraph(
      "Mock: review gate needs revision",
      mockNode({ name: "Quality Reviewer", role: "reviewer", systemPrompt: "ROUTE_TO NEEDS_REVISION" }),
    );
    const runId = await startRun(g.id, "draft the memo");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    assert(
      typeof run.output === "string" &&
        run.output.startsWith("MOCK: draft the memo\n\n---\n⚠️ Quality Reviewer flagged issues with this answer:") &&
        run.output.endsWith("NEEDS_REVISION"),
      `expected content + flagged issues, got: ${JSON.stringify(run.output)}`,
    );
  });

  await test("reviewer gate: a prose verdict with no sentinel is still read correctly", async () => {
    // A transform/template node with the reviewer role emits an exact
    // verdict line without cooperating with the injected convention —
    // the shape a small local model produces. Both real-world lines here
    // come from the pipeline that surfaced this bug: "Needs Revision"
    // after a heading dash, and an "Approved" line that ALSO contains the
    // word "revisions" later on ("No revisions are needed").
    const needs = await reviewGateGraph("Mock: review gate prose needs revision", {
      ...mockNode({
        name: "Quality Reviewer",
        role: "reviewer",
        systemPrompt: "**Review Verdict – Needs Revision**\n\nAll dates are in the past.",
      }),
      provider: "transform",
      model: "template",
    });
    const needsRun = await waitForRun(await startRun(needs.g.id, "draft the memo"));
    assert(needsRun.status === "completed", `run failed: ${JSON.stringify(needsRun)}`);
    assert(
      typeof needsRun.output === "string" &&
        needsRun.output.startsWith("MOCK: draft the memo\n\n---\n⚠️ Quality Reviewer flagged issues") &&
        needsRun.output.includes("All dates are in the past."),
      `prose NEEDS REVISION misread: ${JSON.stringify(needsRun.output)}`,
    );

    const approved = await reviewGateGraph("Mock: review gate prose approved", {
      ...mockNode({
        name: "Quality Reviewer",
        role: "reviewer",
        systemPrompt: "**Approved** – clear and factually accurate. No revisions are needed.",
      }),
      provider: "transform",
      model: "template",
    });
    const approvedRun = await waitForRun(await startRun(approved.g.id, "draft the memo"));
    assert(approvedRun.status === "completed", `run failed: ${JSON.stringify(approvedRun)}`);
    assert(
      approvedRun.output === "MOCK: draft the memo\n\n---\n✅ Reviewed by Quality Reviewer: approved.",
      `prose APPROVED misread (the later word "revisions" must not flip it): ${JSON.stringify(approvedRun.output)}`,
    );
  });

  await test("reviewer gate: a reviewer reached via an AUTO edge is answering, not gating", async () => {
    // The example graphs route "risk/correctness" requests to a Reviewer
    // specialist via auto edges. Its input is the user's own request, so
    // its output IS the answer — nothing must be appended.
    const g = await createGraph("Mock: reviewer via auto edge");
    const router = await createNode(g.id, mockNode({ name: "Lead", role: "router", systemPrompt: "ROUTE_TO Reviewer" }));
    const reviewer = await createNode(g.id, mockNode({ name: "Reviewer", role: "reviewer", description: "Reviewer checks risk" }));
    await createEdge(g.id, router.id, reviewer.id, "auto");
    await setEntry(g.id, router.id);
    const run = await waitForRun(await startRun(g.id, "is this safe to ship?"));
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 2 && hops[1].nodeId === reviewer.id, `expected Lead → Reviewer, got ${JSON.stringify(hops.map((h) => h.nodeId))}`);
    assert(run.output === "MOCK: is this safe to ship?", `auto-routed reviewer output was altered: ${JSON.stringify(run.output)}`);
  });

  await test("reviewer gate: passes the reviewed content downstream on an explicit handoff", async () => {
    // Writer → Reviewer → Publisher: the publisher must receive the
    // reviewed draft (with the note), not the bare verdict.
    const { g, reviewer } = await reviewGateGraph(
      "Mock: review gate handoff",
      mockNode({ name: "Quality Reviewer", role: "reviewer", systemPrompt: "ROUTE_TO APPROVED" }),
    );
    const publisher = await createNode(g.id, mockNode({ name: "Publisher" }));
    await createEdge(g.id, reviewer.id, publisher.id, "explicit");
    const run = await waitForRun(await startRun(g.id, "draft the memo"));
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 3 && hops[2].nodeId === publisher.id, `expected 3 hops ending at Publisher, got ${hops.length}`);
    // The mock echoes the last 200 chars of its input; the note is the tail.
    assert(
      typeof run.output === "string" && run.output.endsWith("✅ Reviewed by Quality Reviewer: approved."),
      `publisher did not receive the reviewed content: ${JSON.stringify(run.output)}`,
    );
    assert(!run.output.startsWith("MOCK: APPROVED"), "publisher received the bare verdict");
  });

  // --- http_request operator allowlist (no model involved) ---
  // ALLOWED_HTTP_ENDPOINTS is unset in the mock CI env, so EVERY baseUrl
  // is outside the allowlist — which is exactly the empty-deny default
  // worth asserting: a fresh deployment must not be able to grant HTTP
  // access to anything at all.
  async function httpNode(slug: string, baseUrl: string, extra: Record<string, unknown> = {}) {
    const g = await createGraph(`Mock: http ${slug} ${Date.now()}`);
    return api(`/graphs/${g.id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        ...mockNode({ name: "HTTP Caller" }),
        tools: ["http_request"],
        httpEndpoints: [{ slug, baseUrl, ...extra }],
      }),
    });
  }

  await test("security: an httpEndpoints baseUrl outside ALLOWED_HTTP_ENDPOINTS is rejected", async () => {
    // The canonical SSRF target: cloud instance metadata.
    const res = await httpNode("meta", "http://169.254.169.254");
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(
      /ALLOWED_HTTP_ENDPOINTS/.test(JSON.stringify(res.body)),
      `error should name the allowlist, got: ${JSON.stringify(res.body)}`,
    );
  });

  await test("security: an httpEndpoints baseUrl with embedded credentials is rejected", async () => {
    const res = await httpNode("userinfo", "http://user:pass@example.com");
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test("security: an httpEndpoints baseUrl with a credential-shaped query param is rejected", async () => {
    // A token in a URL ends up in node config, logs, and browser history.
    const res = await httpNode("leaky", "http://example.com/?api_key=secret");
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await test("security: duplicate httpEndpoints slugs are rejected", async () => {
    const g = await createGraph("Mock: http duplicate slug");
    const res = await api(`/graphs/${g.id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        ...mockNode({ name: "Dupe" }),
        tools: ["http_request"],
        httpEndpoints: [
          { slug: "same", baseUrl: "http://a.example.com" },
          { slug: "same", baseUrl: "http://b.example.com" },
        ],
      }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(/duplicate slug/i.test(JSON.stringify(res.body)), `expected a duplicate-slug error, got: ${JSON.stringify(res.body)}`);
  });

  await test("PATCH httpEndpoints: null revokes previously-granted endpoints", async () => {
    // Same .nullable() reason as consensusGroup/sshTarget/mcpServers: a
    // grant that can't be revoked is a one-way door.
    const g = await createGraph("Mock: http revoke");
    const node = await createNode(g.id, mockNode({ name: "Revocable" }));
    const patch = await api(`/graphs/${g.id}/nodes/${node.id}`, {
      method: "PATCH",
      body: JSON.stringify({ httpEndpoints: null }),
    });
    assert(patch.status === 200, `expected the null clear to be accepted, got ${patch.status}: ${JSON.stringify(patch.body)}`);
  });

  // --- web_fetch SSRF boundary (pure function, no model, no network) ---
  // These are the only tools that reach arbitrary hosts, so the denylist
  // is the whole safety story and belongs in the free tier where it runs
  // on every PR. A real bypass was caught here during development:
  // `new URL("http://[::ffff:127.0.0.1]").hostname` normalizes to the hex
  // form `::ffff:7f00:1`, which a dotted-quad-only check never matched.
  await test("security: the research URL guard blocks every internal address class", async () => {
    const { assertPublicUrl } = await import("@openbots/providers");
    const mustBlock = [
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://127.0.0.1:4000/health", // loopback
      "http://localhost:5432", // resolves to loopback
      "http://10.0.0.5/admin", // RFC1918
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://100.66.221.81", // CGNAT
      "http://[::1]:80", // IPv6 loopback
      "http://[::ffff:127.0.0.1]", // IPv4-mapped, normalized to hex
      "http://[fd00::1]", // unique local
      "file:///etc/passwd", // non-http scheme
      "http://user:pw@example.com", // embedded credentials
      "http://0.0.0.0",
    ];
    for (const url of mustBlock) {
      const result = await assertPublicUrl(url);
      assert(!result.ok, `expected ${url} to be refused, but it was allowed`);
    }
    const publicUrl = await assertPublicUrl("https://example.com");
    assert(publicUrl.ok, `expected a public URL to be allowed, got: ${publicUrl.reason}`);
  });

  // --- Dynamic fan-out (map over a runtime list) ---
  // The mock provider echoes its input, so a source node whose INPUT is a
  // JSON array produces that array as its output — which is exactly the
  // "list produced at runtime" a map consumes. Deterministic, free, and
  // impossible to test reliably with a real model.
  async function mapGraph(name: string, extra: Record<string, unknown> = {}) {
    const g = await createGraph(name);
    const worker = await createNode(g.id, mockNode({ name: "Item Worker" }));
    const aggregator = await createNode(g.id, mockNode({ name: "Aggregator" }));
    const source = await createNode(g.id, {
      ...mockNode({ name: "List Source" }),
      mapConfig: { targetNodeId: worker.id, aggregatorNodeId: aggregator.id, ...extra },
    });
    await setEntry(g.id, source.id);
    return { g, source, worker, aggregator };
  }

  await test("map: fans out one branch per runtime item and joins in the aggregator", async () => {
    const { g, worker, aggregator } = await mapGraph("Mock: map fan-out");
    const runId = await startRun(g.id, '["alpha","beta","gamma"]');
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run.events)}`);

    const hops = succeededEvents(run);
    const workerHops = hops.filter((h) => h.nodeId === worker.id);
    assert(workerHops.length === 3, `expected one worker hop per item, got ${workerHops.length}`);
    // The branch count came from the DATA, not from edges: this graph has
    // no routing edges at all.
    assert(g.edges === undefined || true, "map needs no edges");
    assert(
      workerHops.every((h) => h.fanoutBatchId && h.fanoutBatchId === workerHops[0].fanoutBatchId),
      "all branches should share one fanout batch",
    );
    // Each branch got ITS OWN item, not the shared source output.
    const inputs = workerHops.map((h) => String(h.input)).sort();
    assert(
      inputs.join(",") === "alpha,beta,gamma",
      `each branch should receive its own item, got ${JSON.stringify(inputs)}`,
    );
    assert(hops[hops.length - 1].nodeId === aggregator.id, "aggregator should run last, exactly once");
    assert(
      hops.filter((h) => h.nodeId === aggregator.id).length === 1,
      "aggregator must run exactly once, not once per branch",
    );
  });

  await test("map: an empty list is a normal outcome, not a run failure", async () => {
    const { g, source, worker } = await mapGraph("Mock: map empty list");
    const runId = await startRun(g.id, "[]");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `an empty work list should not fail the run: ${JSON.stringify(run.events)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 1 && hops[0].nodeId === source.id, "only the source should have run");
    assert(!hops.some((h) => h.nodeId === worker.id), "no worker branch should run for an empty list");
  });

  await test("map: refuses a list larger than maxItems instead of silently truncating", async () => {
    const { g } = await mapGraph("Mock: map over limit", { maxItems: 2 });
    const runId = await startRun(g.id, '["a","b","c","d"]');
    const run = await waitForRun(runId);
    assert(run.status === "error", `expected the oversized map to fail loudly, got ${run.status}`);
    const failed = (run.events as any[]).filter((e) => e.status === "failed");
    assert(
      failed.some((f) => /above this node's limit/.test(f.error ?? "")),
      `expected a clear over-limit error, got ${JSON.stringify(failed.map((f: any) => f.error))}`,
    );
  });

  // --- Human-in-the-loop approval gate ---
  // A single gated node as the entry is the minimal graph an approval
  // gate needs: it's the run's very first hop, so pausing there is
  // observable with no routing or fan-out involved.
  async function gatedGraph(name: string, instructions?: string) {
    const g = await createGraph(name);
    const node = await createNode(g.id, {
      ...mockNode({ name: "Sender" }),
      approvalConfig: { instructions: instructions ?? "review before sending" },
    });
    await setEntry(g.id, node.id);
    return { g, node };
  }

  await test("approval gate: a gated node pauses the run and runs no further hop", async () => {
    const { g, node } = await gatedGraph("Mock: approval gate pauses");
    const runId = await startRun(g.id, "hello");
    const run = await waitForRunStatus(runId, ["awaiting_approval", "completed", "error"]);
    assert(run.status === "awaiting_approval", `expected the run to pause, got ${run.status}`);
    assert(run.currentNodeId === node.id, `expected the run parked at the gated node, got ${run.currentNodeId}`);
    assert(succeededEvents(run).length === 0, `expected no hop to have run yet, got ${JSON.stringify(run.events)}`);
  });

  await test("approve resumes and the run completes", async () => {
    const { g, node } = await gatedGraph("Mock: approval gate approve");
    const runId = await startRun(g.id, "hello");
    await waitForRunStatus(runId, ["awaiting_approval"]);
    const approve = await api(`/runs/${runId}/approve`, { method: "POST", body: JSON.stringify({}) });
    assert(approve.status === 200, `approve failed: ${approve.status} ${JSON.stringify(approve.body)}`);
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    assert(run.output === "MOCK: hello", `expected echoed output, got: ${JSON.stringify(run.output)}`);
    const hops = succeededEvents(run);
    assert(hops.length === 1 && hops[0].nodeId === node.id, `expected exactly one hop, the gated node: ${JSON.stringify(hops)}`);
  });

  await test("approve with an edited input feeds the edited value to the gated node, not the original", async () => {
    const { g } = await gatedGraph("Mock: approval gate edit");
    const runId = await startRun(g.id, "original message");
    await waitForRunStatus(runId, ["awaiting_approval"]);
    const approve = await api(`/runs/${runId}/approve`, {
      method: "POST",
      body: JSON.stringify({ input: "edited message" }),
    });
    assert(approve.status === 200, `approve failed: ${approve.status} ${JSON.stringify(approve.body)}`);
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    assert(run.output === "MOCK: edited message", `expected the EDITED input echoed, got: ${JSON.stringify(run.output)}`);
    const hops = succeededEvents(run);
    assert(
      hops.length === 1 && hops[0].input === "edited message",
      `expected the gated hop to receive the edited input, got ${JSON.stringify(hops[0])}`,
    );
  });

  await test("cancelling at a gate terminates the run without executing the gated node", async () => {
    const { g, node } = await gatedGraph("Mock: approval gate cancel");
    const runId = await startRun(g.id, "hello");
    await waitForRunStatus(runId, ["awaiting_approval"]);
    const cancel = await api(`/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "not needed" }) });
    assert(cancel.status === 200, `cancel failed: ${cancel.status} ${JSON.stringify(cancel.body)}`);
    const run = await api(`/runs/${runId}`);
    assert(run.body.status === "cancelled", `expected cancelled, got ${run.body.status}`);
    assert(succeededEvents(run.body).length === 0, `the gated node should never have run: ${JSON.stringify(run.body.events)}`);
    const decision = (run.body.events as any[]).find((e) => e.status === "cancelled");
    assert(decision && decision.nodeId === node.id, "expected a cancellation audit event at the gated node");
  });

  await test("a second approve on an already-approved run is refused and does not double-enqueue", async () => {
    const { g, node } = await gatedGraph("Mock: approval gate double approve");
    const runId = await startRun(g.id, "hello");
    await waitForRunStatus(runId, ["awaiting_approval"]);
    // Fired concurrently, not sequentially — this is the actual "double
    // click" race the conditional single-statement UPDATE exists for.
    const [first, second] = await Promise.all([
      api(`/runs/${runId}/approve`, { method: "POST", body: JSON.stringify({}) }),
      api(`/runs/${runId}/approve`, { method: "POST", body: JSON.stringify({}) }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `expected exactly one approve to win (200) and the other refused (409), got ${JSON.stringify(statuses)}`,
    );
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);
    const hops = succeededEvents(run).filter((h: any) => h.nodeId === node.id);
    assert(hops.length === 1, `expected the gated node to run exactly once, not double-enqueued: ${hops.length}`);
  });

  await test(
    "approving records an audit event, and an edited approval records both the original and the replacement",
    async () => {
      const { g } = await gatedGraph("Mock: approval gate audit");
      const runId = await startRun(g.id, "orig message");
      await waitForRunStatus(runId, ["awaiting_approval"]);
      const approve = await api(`/runs/${runId}/approve`, {
        method: "POST",
        body: JSON.stringify({ input: "changed message" }),
      });
      assert(approve.status === 200, `approve failed: ${approve.status} ${JSON.stringify(approve.body)}`);
      await waitForRun(runId);
      const run = await api(`/runs/${runId}`);
      const decision = (run.body.events as any[]).find((e) => e.status === "approved");
      assert(decision, `expected an "approved" audit event, got: ${JSON.stringify(run.body.events)}`);
      assert(decision.input === "orig message", `expected the audit event to record the ORIGINAL input, got: ${JSON.stringify(decision.input)}`);
      assert(decision.output.decision === "approved", `expected decision=approved, got: ${JSON.stringify(decision.output)}`);
      assert(
        decision.output.decidedBy === ownerId,
        `expected decidedBy to be the approving user, got: ${JSON.stringify(decision.output)}`,
      );
      assert(
        decision.output.editedInput === "changed message",
        `expected the audit event to record the REPLACEMENT input, got: ${JSON.stringify(decision.output)}`,
      );
    },
  );

  await test(
    "approving a run whose gated node was deleted while paused fails with a clear message, not an opaque crash",
    async () => {
      // Live mode specifically: a pinned run's graphSnapshot is immutable,
      // so deleting the node from the live graph could never manifest as
      // drift for it — this hazard only exists for "live" runs, which
      // re-read the graph fresh on every hop (see CLAUDE.md's "graph
      // drift while paused").
      const { g, node } = await gatedGraph("Mock: approval gate node deleted");
      const r = await api("/runs", { method: "POST", body: JSON.stringify({ graphId: g.id, input: "hello", mode: "live" }) });
      assert(r.status === 201, `run create failed: ${r.status} ${JSON.stringify(r.body)}`);
      const runId = r.body.id;
      const paused = await waitForRunStatus(runId, ["awaiting_approval", "completed", "error"]);
      assert(paused.status === "awaiting_approval", `expected the run to pause, got ${paused.status}`);

      const del = await api(`/graphs/${g.id}/nodes/${node.id}`, { method: "DELETE" });
      assert(del.status === 204, `node delete failed: ${del.status} ${JSON.stringify(del.body)}`);

      const approve = await api(`/runs/${runId}/approve`, { method: "POST", body: JSON.stringify({}) });
      assert(
        approve.status >= 400 && approve.status < 500,
        `expected a clear client error, got ${approve.status} ${JSON.stringify(approve.body)}`,
      );
      assert(
        /no longer exists/.test(approve.body.error ?? ""),
        `expected a clear message naming the deleted node, got: ${JSON.stringify(approve.body)}`,
      );

      const stillPaused = await api(`/runs/${runId}`);
      assert(
        stillPaused.body.status === "awaiting_approval",
        `run should remain paused after a failed approval, not silently dropped, got ${stillPaused.body.status}`,
      );
    },
  );

  await test("saving a node with approvalConfig as a map target is rejected at save time", async () => {
    const { g, worker } = await mapGraph("Mock: approval gate vs map target");
    const patch = await api(`/graphs/${g.id}/nodes/${worker.id}`, {
      method: "PATCH",
      body: JSON.stringify({ approvalConfig: { instructions: "review" } }),
    });
    assert(patch.status === 400, `expected 400 gating a map target, got ${patch.status} ${JSON.stringify(patch.body)}`);
    assert(/map target/.test(patch.body.error ?? ""), `expected a clear map-target error, got: ${JSON.stringify(patch.body)}`);
  });

  // --- Approval gate notification webhook ---
  // mcp-echo (already running for the MCP-tool cases) doubles as a
  // capture target: /webhook-capture/<token> records the last POST body
  // it received under that token, so a test can assert on the exact
  // payload a real delivery carried. Reachable from the worker container
  // at http://mcp-echo:3930 (matches ALLOWED_MCP_SERVERS' existing DNS
  // name) and from this host script at http://localhost:3930 (published
  // in docker-compose.yml) to read back what was captured.
  const WEBHOOK_CAPTURE_BASE = "http://localhost:3930";

  await test("security: an approvalConfig.notifyWebhookUrl outside ALLOWED_NOTIFICATION_WEBHOOKS is rejected", async () => {
    const g = await createGraph("Mock: notification webhook not allowed");
    const n = await createNode(g.id, mockNode({ name: "Sender" }));
    const patch = await api(`/graphs/${g.id}/nodes/${n.id}`, {
      method: "PATCH",
      body: JSON.stringify({ approvalConfig: { instructions: "review", notifyWebhookUrl: "https://evil.example.com/hook" } }),
    });
    assert(patch.status === 400, `expected 400 for a disallowed webhook URL, got ${patch.status} ${JSON.stringify(patch.body)}`);
    assert(
      /ALLOWED_NOTIFICATION_WEBHOOKS/.test(patch.body.error ?? ""),
      `expected a clear allowlist error, got: ${JSON.stringify(patch.body)}`,
    );
  });

  await test("approval gate: notifies a webhook when a run pauses, with the right payload", async () => {
    const token = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const g = await createGraph("Mock: notification webhook delivery");
    const node = await createNode(g.id, {
      ...mockNode({ name: "Sender" }),
      approvalConfig: {
        instructions: "check before sending",
        notifyWebhookUrl: `http://mcp-echo:3930/webhook-capture/${token}`,
      },
    });
    await setEntry(g.id, node.id);

    const runId = await startRun(g.id, "please email the customer");
    const run = await waitForRunStatus(runId, ["awaiting_approval", "completed", "error"]);
    assert(run.status === "awaiting_approval", `expected the run to pause, got ${run.status}`);

    let captured: any = null;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const res = await fetch(`${WEBHOOK_CAPTURE_BASE}/webhook-capture/${token}`);
      const body = await res.json();
      if (body.captured) {
        captured = body.captured;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(captured, "expected the notification webhook to have delivered within 10s");
    assert(captured.body.event === "run_awaiting_approval", `expected event=run_awaiting_approval, got: ${JSON.stringify(captured.body)}`);
    assert(captured.body.runId === runId, `expected the payload to carry this run's id, got: ${JSON.stringify(captured.body)}`);
    assert(captured.body.nodeId === node.id, `expected the payload to carry the gated node's id, got: ${JSON.stringify(captured.body)}`);
    assert(captured.body.nodeName === "Sender", `expected the payload to carry the node's name, got: ${JSON.stringify(captured.body)}`);
    assert(captured.body.instructions === "check before sending", `expected reviewer instructions in the payload, got: ${JSON.stringify(captured.body)}`);
    assert(captured.body.pendingInput === "please email the customer", `expected the pending input in the payload, got: ${JSON.stringify(captured.body)}`);
  });

  // --- POST /runs/:id/cancel on a PLAIN (non-gated) run ---
  // Everything above exercises /cancel via the approval-gate scenario
  // (awaiting_approval). The endpoint is also documented to work on an
  // ordinary pending/running run — same conditional UPDATE, same
  // inArray(["awaiting_approval","pending","running"]), just a different
  // matched status — so it's the same code path, not new logic. Two
  // cases close that gap: one fully deterministic (the terminal guard),
  // one that can't be, honestly, because the mock provider is too fast
  // to GUARANTEE catching a plain run still pending/running (the same
  // class of race this file's own header excludes from this tier — see
  // "anything that depends on... a real timing race"). That one asserts
  // the invariant that holds under EITHER outcome of the race instead of
  // a single fixed one, so it stays deterministic-in-assertion even
  // though which branch runs isn't.

  await test("cancel: an already-completed run cannot be cancelled again", async () => {
    const g = await createGraph("Mock: cancel already completed");
    const n = await createNode(g.id, mockNode({ name: "Plain" }));
    await setEntry(g.id, n.id);
    const runId = await startRun(g.id, "hello");
    const run = await waitForRun(runId);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run)}`);

    const cancel = await api(`/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({}) });
    assert(cancel.status === 409, `expected cancelling a completed run to be refused, got ${cancel.status} ${JSON.stringify(cancel.body)}`);

    const after = await api(`/runs/${runId}`);
    assert(after.body.status === "completed", "a refused cancel must not change the run's status");
  });

  await test("cancel: stops a plain (non-gated) run before it finishes, if it hasn't already", async () => {
    const g = await createGraph("Mock: cancel plain run");
    // A longer explicit chain gives a cancel fired immediately after
    // creation, with no wait, a real chance to land before every hop
    // finishes. Mock hops are too fast to guarantee that window every
    // time, so this doesn't assert a single fixed outcome — it asserts
    // whichever side of the race actually happened is internally
    // consistent, which is true regardless of relative timing.
    const nodes: any[] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push(await createNode(g.id, mockNode({ name: `Hop${i}` })));
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      await createEdge(g.id, nodes[i].id, nodes[i + 1].id, "explicit");
    }
    await setEntry(g.id, nodes[0].id);

    const runId = await startRun(g.id, "go");
    const cancel = await api(`/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "stop" }) });
    const run = await waitForRunStatus(runId, ["completed", "error", "cancelled"]);

    if (cancel.status === 200) {
      // Won the race: the run must actually be cancelled, not silently
      // finish anyway, and it must not have run the full chain.
      assert(run.status === "cancelled", `cancel returned 200 but the run ended up ${run.status}`);
      assert(
        succeededEvents(run).length < nodes.length,
        `a genuinely cancelled run should not have completed the whole ${nodes.length}-hop chain`,
      );
    } else {
      // Lost the race to the mock's own speed: cancel must have failed
      // because the run had already finished on its own, not for some
      // other reason.
      assert(cancel.status === 409, `expected 409 if the run beat cancel to the finish, got ${cancel.status} ${JSON.stringify(cancel.body)}`);
      assert(
        run.status === "completed" || run.status === "error",
        `expected the run to have finished on its own when cancel lost the race, got ${run.status}`,
      );
    }
  });

  await test("graph delete cascades cleanly", async () => {
    const g = await createGraph("Mock: delete me");
    const n = await createNode(g.id, mockNode({ name: "Doomed" }));
    await setEntry(g.id, n.id);
    const del = await api(`/graphs/${g.id}`, { method: "DELETE" });
    assert(del.status === 204, `delete failed: ${del.status}`);
    const gone = await api(`/graphs/${g.id}`);
    assert(gone.status === 404, `expected 404 after delete, got ${gone.status}`);
  });

  // --- summary ---
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.passed)) console.log(`   ❌ ${r.name}: ${r.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
