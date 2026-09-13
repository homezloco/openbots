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

  await test("health check", async () => {
    const { status, body } = await api("/health");
    assert(status === 200 && body.status === "ok", `unexpected: ${status} ${JSON.stringify(body)}`);
  });

  await test("signup + session cookie works", async () => {
    const signup = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    assert(signup.status === 201, `signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
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
