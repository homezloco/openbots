/**
 * End-to-end test suite: exercises the real running stack (Postgres,
 * Redis, api, worker) over HTTP exactly like a real client would — no
 * mocks, real Anthropic calls. Run with `pnpm --filter @openbots/api
 * test:e2e` against a stack already up via `docker compose up`.
 *
 * This exists specifically to close the gaps identified in PLAN.md's
 * "Known gaps" section: consensus fan-out, fallback-chain classification,
 * credential storage, and mid-run rerouting had never actually been run.
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

async function waitForRun(runId: string, timeoutMs = 90_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/runs/${runId}`);
    if (body.status === "completed" || body.status === "error") return body;
    await new Promise((r) => setTimeout(r, 1500));
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

/**
 * For a test that's inherently a real timing race (not a code bug) — the
 * mechanism it verifies is correct-by-construction (see
 * docs/orchestration.md), but a single attempt can lose the race if the
 * model responds unusually fast. Retries the whole flow with a fresh
 * graph rather than growing the prompt indefinitely to chase reliability.
 */
async function testWithRetries(name: string, fn: () => Promise<void>, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      results.push({ name, passed: true, durationMs: 0 });
      console.log(`✅ ${name}${i > 1 ? ` (attempt ${i}/${attempts})` : ""}`);
      return;
    } catch (err) {
      if (i === attempts) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name, passed: false, error: message, durationMs: 0 });
        console.log(`❌ ${name} (failed all ${attempts} attempts): ${message}`);
        return;
      }
      console.log(`   (attempt ${i}/${attempts} lost the timing race, retrying: ${err instanceof Error ? err.message : err})`);
    }
  }
}

async function main() {
  const email = `e2e-${Date.now()}@openbots.dev`;
  const password = "e2e-test-password-123";

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

  // --- Basic explicit pipeline + regression check for the position-shape bug ---
  let basicGraphId = "";
  let nodeA = "";
  let nodeB = "";
  await test("create graph + 2 explicit-routed nodes (position shape regression check)", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E basic pipeline" }) });
    assert(g.status === 201, `graph create failed: ${JSON.stringify(g.body)}`);
    basicGraphId = g.body.id;
    assert(
      Array.isArray(g.body.nodes) && Array.isArray(g.body.edges) && Array.isArray(g.body.warnings),
      "POST /graphs response missing nodes/edges/warnings",
    );

    const a = await api(`/graphs/${basicGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Triage",
        role: "router",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Classify the request in one line: billing or technical.",
        description: "Classifies incoming requests",
        position: { x: 0, y: 0 },
      }),
    });
    assert(a.status === 201, `node A create failed: ${JSON.stringify(a.body)}`);
    assert(
      a.body.position && typeof a.body.position.x === "number" && typeof a.body.position.y === "number",
      "created node missing nested position — regression of the earlier position-shape bug",
    );
    nodeA = a.body.id;

    const b = await api(`/graphs/${basicGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Responder",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Write a brief, friendly reply based on the triage note.",
        description: "Writes the customer reply",
        position: { x: 300, y: 0 },
      }),
    });
    nodeB = b.body.id;

    const e = await api(`/graphs/${basicGraphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: nodeA, targetNodeId: nodeB, kind: "explicit" }),
    });
    assert(e.status === 201, `edge create failed: ${JSON.stringify(e.body)}`);

    const patched = await api(`/graphs/${basicGraphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: nodeA }) });
    assert(patched.body.entryNodeId === nodeA, "entryNodeId not set");
  });

  await test("run completes through both explicit hops with usage tracked", async () => {
    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ graphId: basicGraphId, input: "My invoice charged me twice." }),
    });
    assert(created.status === 201, `run create failed: ${JSON.stringify(created.body)}`);
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run did not complete: ${run.status} ${JSON.stringify(run.events)}`);
    assert(run.events.length === 2, `expected 2 hops, got ${run.events.length}`);
    assert(run.events[0].nodeId === nodeA && run.events[1].nodeId === nodeB, "hop order/target mismatch");
    assert(run.usageTotal.inputTokens > 0 && run.usageTotal.outputTokens > 0, "usage tracking recorded zero tokens");
  });

  // --- Regression: GET /graphs/:id/runs must recover the TRUE original input on a multi-hop run ---
  await test("GET /graphs/:id/runs returns the original input, not the mutated final hop's input", async () => {
    // Reuses the 2-hop run from the test above: by completion, runs.input
    // has been overwritten with nodeA's output (nodeB's input) — a
    // conversation-memory chaining bug (useBotChat.buildNextInput) traced
    // to exactly this: it silently dropped all prior context for any
    // multi-hop run because it trusted the mutated `input` field.
    const list = await api(`/graphs/${basicGraphId}/runs`);
    assert(list.status === 200, `failed to list runs: ${JSON.stringify(list.body)}`);
    const twoHopRun = list.body.find((r: any) => r.status === "completed" && r.originalInput === "My invoice charged me twice.");
    assert(
      twoHopRun,
      `expected a run with originalInput "My invoice charged me twice.", got: ${JSON.stringify(list.body.map((r: any) => r.originalInput))}`,
    );
    assert(
      twoHopRun.input !== "My invoice charged me twice.",
      "expected the raw (mutated) input field to differ from originalInput, proving this test actually exercises the bug scenario",
    );
  });

  // --- Reviewer/tier warning ---
  await test("reviewer tier-mismatch warning fires", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E reviewer tier" }) });
    const graphId = g.body.id;
    const worker = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Worker",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        tier: "flagship",
        systemPrompt: "Say hello.",
        position: { x: 0, y: 0 },
      }),
    });
    const reviewer = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Reviewer",
        role: "reviewer",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        tier: "economy",
        systemPrompt: "Review it.",
        position: { x: 300, y: 0 },
      }),
    });
    await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: worker.body.id, targetNodeId: reviewer.body.id, kind: "explicit" }),
    });
    const graph = await api(`/graphs/${graphId}`);
    assert(graph.body.warnings.length === 1, `expected 1 warning, got ${JSON.stringify(graph.body.warnings)}`);
    assert(
      graph.body.warnings[0].includes("Reviewer") && graph.body.warnings[0].includes("economy"),
      `unexpected warning text: ${graph.body.warnings[0]}`,
    );
  });

  // --- Auto-edge delegation ---
  await test("auto-edge delegation routes to the correct specialist", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E delegation" }) });
    const graphId = g.body.id;

    const master = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Master",
        role: "supervisor",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt:
          "Decide which specialist should handle this: BILLING or CODE. Respond with the team name in capitals first, then one sentence restating the request.",
        description: "Routes requests",
        position: { x: 300, y: 0 },
      }),
    });

    const billing = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Billing",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Answer the billing question briefly.",
        description: "Handles BILLING invoices payments subscription pricing questions",
        position: { x: 0, y: 180 },
      }),
    });

    const code = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Code",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Answer the code question briefly.",
        description: "Handles CODE repository bug technical implementation questions",
        position: { x: 300, y: 180 },
      }),
    });

    await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: master.body.id, targetNodeId: billing.body.id, kind: "auto" }),
    });
    await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: master.body.id, targetNodeId: code.body.id, kind: "auto" }),
    });
    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: master.body.id }) });

    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ graphId, input: "Why was I charged twice on my subscription?" }),
    });
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run.events)}`);
    assert(run.events[1].nodeId === billing.body.id, `expected billing routing, got hop to ${run.events[1].nodeId}`);
  });

  // --- Consensus fan-out/join ---
  await test("consensus fan-out runs both branches concurrently and reaches the aggregator", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E consensus" }) });
    const graphId = g.body.id;

    const source = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Source",
        role: "router",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Repeat the user's message back verbatim, unchanged. Output nothing else.",
        position: { x: 300, y: 0 },
      }),
    });

    const branchA = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "OptimisticEstimator",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You are an optimistic estimator. Give one brief, positive-leaning sentence estimating the answer.",
        position: { x: 0, y: 180 },
      }),
    });

    const branchB = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "ConservativeEstimator",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You are a conservative estimator. Give one brief, cautious sentence estimating the answer.",
        position: { x: 600, y: 180 },
      }),
    });

    const aggregator = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Aggregator",
        role: "reviewer",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt:
          "You receive a JSON array of estimates from different analysts. Synthesize them into one final balanced answer in 1-2 sentences, and explicitly say you considered multiple perspectives.",
        position: { x: 300, y: 360 },
      }),
    });

    const edgeA = await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: source.body.id, targetNodeId: branchA.body.id, kind: "consensus" }),
    });
    const edgeB = await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: source.body.id, targetNodeId: branchB.body.id, kind: "consensus" }),
    });

    // consensusGroup references edge ids that don't exist until after the
    // edges above are created — this PATCH is the only way to set it.
    const patched = await api(`/graphs/${graphId}/nodes/${source.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        consensusGroup: { edgeIds: [edgeA.body.id, edgeB.body.id], aggregatorNodeId: aggregator.body.id },
      }),
    });
    assert(patched.status === 200, `failed to set consensusGroup: ${JSON.stringify(patched.body)}`);

    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: source.body.id }) });

    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ graphId, input: "How long will this migration project take?" }),
    });
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run did not complete: ${run.status} ${JSON.stringify(run.events)}`);
    assert(run.events.length === 4, `expected 4 hops (source, 2 branches, aggregator), got ${run.events.length}`);

    const branchEvents = run.events.filter((e: any) => e.nodeId === branchA.body.id || e.nodeId === branchB.body.id);
    assert(branchEvents.length === 2, `expected 2 branch events, got ${branchEvents.length}`);
    assert(
      branchEvents[0].fanoutBatchId && branchEvents[0].fanoutBatchId === branchEvents[1].fanoutBatchId,
      "branch events don't share a fanoutBatchId",
    );

    const aggregatorEvent = run.events.find((e: any) => e.nodeId === aggregator.body.id);
    assert(aggregatorEvent, "aggregator never ran");
    assert(typeof run.output === "string" && run.output.length > 20, "aggregator produced no meaningful output");
  });

  // --- File-access tool: read within root + blocked traversal ---
  await test("file-access tool reads within its root and blocks path traversal", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E file access" }) });
    const graphId = g.body.id;

    const node = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "RepoReader",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You have read-only access to a directory via list_directory and read_file. Use them to answer.",
        tools: ["read_file", "list_directory"],
        fileAccessRoot: "/tmp/testrepo",
        position: { x: 0, y: 0 },
      }),
    });
    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: node.body.id }) });

    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({
        graphId,
        input:
          "What does the README say this project does? Also try to read a file called ../outside_root_secret.txt and tell me what happens.",
      }),
    });
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run.events)}`);
    const output = String(run.output);
    assert(/widgetizer/i.test(output), `expected README content (Widgetizer) in output, got: ${output.slice(0, 200)}`);
    assert(/escapes the allowed root|blocked|denied|could not|cannot access/i.test(output), `expected traversal-blocked language in output, got: ${output.slice(0, 300)}`);
  });

  // --- Template save/instantiate ---
  await test("save graph as template and instantiate a deep copy", async () => {
    const template = await api("/templates", {
      method: "POST",
      body: JSON.stringify({ graphId: basicGraphId, name: `E2E template ${Date.now()}` }),
    });
    assert(template.status === 201, `template create failed: ${JSON.stringify(template.body)}`);

    const list = await api("/templates");
    assert(list.body.some((t: any) => t.id === template.body.id), "new template not in list");

    const instantiated = await api(`/templates/${template.body.id}/instantiate`, { method: "POST" });
    assert(instantiated.status === 201, `instantiate failed: ${JSON.stringify(instantiated.body)}`);
    assert(instantiated.body.nodes.length === 2, `expected 2 nodes in instantiated graph, got ${instantiated.body.nodes.length}`);
    assert(instantiated.body.id !== basicGraphId, "instantiated graph reused the original graph id");
    assert(
      instantiated.body.nodes.every((n: any) => n.id !== nodeA && n.id !== nodeB),
      "instantiated graph reused original node ids instead of generating fresh ones",
    );
  });

  // --- Credential storage: stored credential is actually used, not silently skipped ---
  await test("stored per-node credential is resolved and used (not skipped for the env var)", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E credential storage" }) });
    const graphId = g.body.id;

    const node = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "OpenAINode",
        role: "worker",
        provider: "openai",
        model: "gpt-4o-mini",
        systemPrompt: "Say hello.",
        position: { x: 0, y: 0 },
      }),
    });
    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: node.body.id }) });

    const cred = await api(`/graphs/${graphId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: "sk-fake-key-for-e2e-testing-000000", nodeId: node.body.id, label: "e2e fake key" }),
    });
    assert(cred.status === 201, `credential create failed: ${JSON.stringify(cred.body)}`);
    assert(!("apiKey" in cred.body) && !("encryptedKey" in cred.body), "credential response leaked the key");

    const list = await api(`/graphs/${graphId}/credentials`);
    assert(list.body.length === 1 && !("encryptedKey" in list.body[0]), "credential list leaked the key or has wrong count");

    // OPENAI_API_KEY is not set in this environment, so if credential
    // resolution incorrectly fell through to the env var, the failure
    // would be "Missing required env var: OPENAI_API_KEY" — a JS-thrown
    // error that never reaches the network. Getting a *different* error
    // (a real HTTP call rejected by OpenAI for the fake key) proves the
    // stored credential was the one actually used.
    const created = await api("/runs", { method: "POST", body: JSON.stringify({ graphId, input: "hi" }) });
    const run = await waitForRun(created.body.id);
    assert(run.status === "error", `expected the run to fail (fake key), got ${run.status}`);
    const errorText = run.events[0]?.error ?? "";
    assert(!/Missing required env var/i.test(errorText), `credential resolution fell through to env var instead of using the stored one: ${errorText}`);
    console.log(`   (stored-credential error, as expected: ${errorText.slice(0, 150)})`);
  });

  // --- Fallback chain: classification causes fallthrough (verified via final error, not a full recovery) ---
  await test("fallback chain: auth error on primary causes fallthrough to the next target", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E fallback chain" }) });
    const graphId = g.body.id;

    const node = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "FallbackNode",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Say hello.",
        fallbackChain: [{ provider: "xai", model: "grok-4" }],
        position: { x: 0, y: 0 },
      }),
    });
    // Bad node-specific credential forces a real 401 from Anthropic on the primary attempt.
    await api(`/graphs/${graphId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-invalid-key-for-e2e-000000", nodeId: node.body.id }),
    });
    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: node.body.id }) });

    const created = await api("/runs", { method: "POST", body: JSON.stringify({ graphId, input: "hi" }) });
    const run = await waitForRun(created.body.id);
    assert(run.status === "error", `expected failure (no real xai key configured either), got ${run.status}`);
    const errorText = run.events[0]?.error ?? "";
    // XAI_API_KEY is unset in this environment. Reaching ITS "missing env
    // var" error (rather than surfacing Anthropic's 401 directly) proves
    // the primary's auth error was classified correctly and the chain
    // fell through to the fallback target, exactly as designed — this
    // environment just doesn't have a second real provider key to prove
    // a full successful recovery. See PLAN.md.
    assert(/XAI_API_KEY/i.test(errorText), `expected the chain to have fallen through to the xai target's missing-key error, got: ${errorText}`);
    console.log(`   (chain progressed to fallback target as expected: ${errorText.slice(0, 150)})`);
  });

  // --- Mid-run rerouting: the actual headline differentiator, never previously demonstrated ---
  await testWithRetries("mid-run rerouting: a reroute fired while the first hop is executing changes the next hop", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E mid-run reroute" }) });
    const graphId = g.body.id;

    const entry = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Entry",
        role: "router",
        provider: "anthropic",
        model: "claude-sonnet-5",
        // Deliberately long-winded: the reroute has to land before this
        // finishes generating, and a one-word reply leaves almost no
        // window (a real failure seen on the first run of this test).
        systemPrompt:
          "Write a detailed, at least 150-word analysis of the pros and cons of remote work versus office work, covering productivity, collaboration, and work-life balance, before concluding with the single word OK on its own line.",
        position: { x: 300, y: 0 },
      }),
    });
    const originalTarget = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "OriginalTarget",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Say ORIGINAL.",
        position: { x: 0, y: 180 },
      }),
    });
    const rerouteTarget = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "RerouteTarget",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Say REROUTED.",
        position: { x: 600, y: 180 },
      }),
    });
    const edge = await api(`/graphs/${graphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: entry.body.id, targetNodeId: originalTarget.body.id, kind: "explicit" }),
    });
    await api(`/graphs/${graphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: entry.body.id }) });

    // mode: "live" is required here — "pinned" (the default) snapshots
    // the graph at creation and never re-reads it, so a reroute would be
    // silently ignored regardless of timing. Missing this the first time
    // through produced a deterministic, always-fails "race" that had
    // nothing to do with timing at all.
    const created = await api("/runs", { method: "POST", body: JSON.stringify({ graphId, input: "go", mode: "live" }) });
    assert(created.status === 201, `run create failed: ${JSON.stringify(created.body)}`);

    // Fired immediately after run creation, before the entry hop's model
    // call (which takes at least ~1s in practice) has had time to finish
    // and resolve its next hop. This is inherently timing-sensitive.
    const reroute = await api(`/graphs/${graphId}/edges/${edge.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ targetNodeId: rerouteTarget.body.id }),
    });
    assert(reroute.status === 200, `reroute failed: ${JSON.stringify(reroute.body)}`);

    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run did not complete: ${JSON.stringify(run.events)}`);
    assert(run.events.length === 2, `expected 2 hops, got ${run.events.length}`);
    assert(
      run.events[1].nodeId === rerouteTarget.body.id,
      `expected the reroute to take effect (hop 2 -> RerouteTarget), but hop 2 went to ${
        run.events[1].nodeId === originalTarget.body.id ? "OriginalTarget — the reroute was too slow/lost the race" : run.events[1].nodeId
      }`,
    );
  });

  // --- Security regression: fileAccessRoot outside the allowlist is rejected ---
  await test("security: fileAccessRoot outside ALLOWED_FILE_ACCESS_ROOTS is rejected", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E security file root" }) });
    const graphId = g.body.id;
    const created = await api(`/graphs/${graphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Snoop",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Read files.",
        tools: ["read_file"],
        fileAccessRoot: "/etc",
        position: { x: 0, y: 0 },
      }),
    });
    assert(created.status === 400, `expected 400 rejecting an out-of-allowlist root, got ${created.status}: ${JSON.stringify(created.body)}`);
  });

  // --- Security regression: IDOR on node/edge/credential mutation routes ---
  await test("security: cannot mutate another user's node via your own graphId (IDOR)", async () => {
    const attackerCookie = sessionCookie;

    // Victim: a second user with their own graph + node.
    sessionCookie = "";
    const victimEmail = `e2e-victim-${Date.now()}@openbots.dev`;
    await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: victimEmail, password }) });
    const victimGraph = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "Victim graph" }) });
    const victimNode = await api(`/graphs/${victimGraph.body.id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "VictimAgent",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "original prompt",
        position: { x: 0, y: 0 },
      }),
    });

    // Attacker: their own graph, then an attempt to PATCH the victim's node
    // by pairing it with their OWN graphId in the URL.
    sessionCookie = attackerCookie;
    const attackerGraph = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "Attacker graph" }) });
    const attack = await api(`/graphs/${attackerGraph.body.id}/nodes/${victimNode.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ systemPrompt: "PWNED" }),
    });
    assert(attack.status === 404, `expected 404 (cross-graph mutation blocked), got ${attack.status}: ${JSON.stringify(attack.body)}`);

    // Confirm the victim's node was actually left untouched.
    sessionCookie = "";
    await api("/auth/login", { method: "POST", body: JSON.stringify({ email: victimEmail, password }) });
    const victimGraphAfter = await api(`/graphs/${victimGraph.body.id}`);
    const stillOriginal = victimGraphAfter.body.nodes.find((n: any) => n.id === victimNode.body.id);
    assert(stillOriginal.systemPrompt === "original prompt", `victim node was mutated by the attacker: ${JSON.stringify(stillOriginal)}`);

    sessionCookie = attackerCookie;
  });

  // --- Security regression: GET /runs/:id requires auth + ownership ---
  await test("security: GET /runs/:id requires authentication and ownership", async () => {
    const run = await api("/runs", { method: "POST", body: JSON.stringify({ graphId: basicGraphId, input: "hi" }) });
    const runId = run.body.id;

    const ownerCookie = sessionCookie;

    sessionCookie = "";
    const unauth = await api(`/runs/${runId}`);
    assert(unauth.status === 401, `expected 401 with no session, got ${unauth.status}: ${JSON.stringify(unauth.body)}`);

    const otherEmail = `e2e-other-${Date.now()}@openbots.dev`;
    await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: otherEmail, password }) });
    const wrongUser = await api(`/runs/${runId}`);
    assert(wrongUser.status === 404, `expected 404 for a non-owning authenticated user, got ${wrongUser.status}: ${JSON.stringify(wrongUser.body)}`);

    sessionCookie = ownerCookie;
    const owner = await api(`/runs/${runId}`);
    assert(owner.status === 200, `expected the actual owner to be able to read their own run, got ${owner.status}`);
  });

  // --- Add existing agent: copies config, excludes consensusGroup, IDOR-safe in both directions ---
  await test("add existing agent copies node config, excluding consensusGroup, with IDOR checks", async () => {
    const sourceGraph = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E source graph" }) });
    const sourceNode = await api(`/graphs/${sourceGraph.body.id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "ReusableAgent",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "distinctive prompt for reuse test",
        description: "distinctive description",
        tools: ["read_file", "list_directory"],
        fileAccessRoot: "/tmp/testrepo",
        position: { x: 0, y: 0 },
      }),
    });

    const targetGraph = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E target graph" }) });
    const copied = await api(`/graphs/${targetGraph.body.id}/nodes/from-existing`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: sourceNode.body.id, position: { x: 10, y: 10 } }),
    });
    assert(copied.status === 201, `expected 201, got ${copied.status}: ${JSON.stringify(copied.body)}`);
    assert(copied.body.id !== sourceNode.body.id, "copy should have a fresh id");
    assert(copied.body.graphId === targetGraph.body.id, "copy should belong to the target graph");
    assert(copied.body.systemPrompt === "distinctive prompt for reuse test", "systemPrompt not copied");
    assert(copied.body.fileAccessRoot === "/tmp/testrepo", "fileAccessRoot not copied");
    assert(copied.body.consensusGroup == null, "consensusGroup should NOT be copied");

    const targetGraphAfter = await api(`/graphs/${targetGraph.body.id}`);
    assert(
      targetGraphAfter.body.nodes.some((n: any) => n.id === copied.body.id),
      "copied node not actually present in target graph",
    );

    // IDOR direction 1: attacker's own target graph + a victim's sourceNodeId.
    const attackerCookie = sessionCookie;
    sessionCookie = "";
    const victimEmail = `e2e-victim-agents-${Date.now()}@openbots.dev`;
    await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: victimEmail, password }) });
    const victimGraph = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "Victim source graph" }) });
    const victimNode = await api(`/graphs/${victimGraph.body.id}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "VictimReusable",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        position: { x: 0, y: 0 },
      }),
    });

    sessionCookie = attackerCookie;
    const attack1 = await api(`/graphs/${targetGraph.body.id}/nodes/from-existing`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: victimNode.body.id, position: { x: 0, y: 0 } }),
    });
    assert(
      attack1.status === 403 || attack1.status === 404,
      `expected the source-graph ownership check to block this, got ${attack1.status}: ${JSON.stringify(attack1.body)}`,
    );

    // IDOR direction 2: attacker's own node as source, victim's graph as target.
    const attack2 = await api(`/graphs/${victimGraph.body.id}/nodes/from-existing`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: sourceNode.body.id, position: { x: 0, y: 0 } }),
    });
    assert(
      attack2.status === 403 || attack2.status === 404,
      `expected the target-graph ownership check to block this, got ${attack2.status}: ${JSON.stringify(attack2.body)}`,
    );

    sessionCookie = attackerCookie;
  });

  // --- Conversation history: routed hops vs a direct message to the same node ---
  await test("agent conversation history distinguishes direct messages from routed hops", async () => {
    // basicGraphId/nodeA/nodeB already have one routed run from the
    // "run completes through both explicit hops" test above (nodeA -> nodeB).
    // Temporarily point entryNodeId at nodeB to create a genuinely direct run.
    await api(`/graphs/${basicGraphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: nodeB }) });
    const direct = await api("/runs", { method: "POST", body: JSON.stringify({ graphId: basicGraphId, input: "Direct hello" }) });
    const directRun = await waitForRun(direct.body.id);
    assert(directRun.status === "completed", `direct run failed: ${JSON.stringify(directRun.events)}`);

    const convos = await api(`/graphs/${basicGraphId}/nodes/${nodeB}/conversations`);
    assert(convos.status === 200, `expected 200, got ${convos.status}: ${JSON.stringify(convos.body)}`);
    assert(convos.body.runs.length >= 2, `expected at least 2 runs involving nodeB, got ${convos.body.runs.length}`);

    const directEntry = convos.body.runs.find((r: any) => r.runId === direct.body.id);
    assert(directEntry, "direct run missing from conversation history");
    assert(directEntry.isDirect === true, `expected the direct run to be marked isDirect, got ${JSON.stringify(directEntry)}`);

    const routedEntry = convos.body.runs.find((r: any) => r.runId !== direct.body.id);
    assert(routedEntry, "routed run missing from conversation history");
    assert(routedEntry.isDirect === false, `expected the routed run to be marked NOT direct, got ${JSON.stringify(routedEntry)}`);

    // Restore entryNodeId in case any future test relies on it.
    await api(`/graphs/${basicGraphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: nodeA }) });
  });

  // --- Hybrid auto/consensus node: single-specialist routing vs. ALL fan-out ---
  let hybridGraphId = "";
  let leadEngineerId = "";
  let projectAlphaId = "";
  let projectBetaId = "";
  let hybridAggregatorId = "";

  await test("hybrid node setup: auto edges reused as a consensusGroup", async () => {
    const g = await api("/graphs", { method: "POST", body: JSON.stringify({ name: "E2E hybrid fan-out" }) });
    hybridGraphId = g.body.id;

    const lead = await api(`/graphs/${hybridGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "LeadEngineer",
        role: "supervisor",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "Route engineering requests to the right project specialist.",
        description: "Routes engineering requests to project specialists",
        position: { x: 300, y: 0 },
      }),
    });
    leadEngineerId = lead.body.id;

    const alpha = await api(`/graphs/${hybridGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "ProjectAlpha",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You are the engineer for Project Alpha. Reply with one short sentence starting 'Alpha status:'.",
        description: "Handles engineering questions about Project Alpha, a fictional inventory tracking system",
        position: { x: 0, y: 180 },
      }),
    });
    projectAlphaId = alpha.body.id;

    const beta = await api(`/graphs/${hybridGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "ProjectBeta",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You are the engineer for Project Beta. Reply with one short sentence starting 'Beta status:'.",
        description: "Handles engineering questions about Project Beta, a fictional billing and payments system",
        position: { x: 600, y: 180 },
      }),
    });
    projectBetaId = beta.body.id;

    const aggregator = await api(`/graphs/${hybridGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Aggregator",
        role: "reviewer",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt:
          "You receive a JSON array of per-project status reports. Combine them into one summary that explicitly mentions both Alpha and Beta.",
        position: { x: 300, y: 360 },
      }),
    });
    hybridAggregatorId = aggregator.body.id;

    const edgeAlpha = await api(`/graphs/${hybridGraphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: leadEngineerId, targetNodeId: projectAlphaId, kind: "auto" }),
    });
    const edgeBeta = await api(`/graphs/${hybridGraphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: leadEngineerId, targetNodeId: projectBetaId, kind: "auto" }),
    });

    // consensusGroup.edgeIds reuse the AUTO edges directly, not separate
    // kind:"consensus" edges — this is what makes LeadEngineer a hybrid
    // node instead of a pure fan-out source.
    const patched = await api(`/graphs/${hybridGraphId}/nodes/${leadEngineerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        consensusGroup: { edgeIds: [edgeAlpha.body.id, edgeBeta.body.id], aggregatorNodeId: hybridAggregatorId },
      }),
    });
    assert(patched.status === 200, `failed to set consensusGroup: ${JSON.stringify(patched.body)}`);

    await api(`/graphs/${hybridGraphId}`, { method: "PATCH", body: JSON.stringify({ entryNodeId: leadEngineerId }) });
  });

  await test("hybrid node: naming one specialist routes normally, no fan-out", async () => {
    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ graphId: hybridGraphId, input: "What is the status of Project Alpha?" }),
    });
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run.events)}`);
    assert(run.events.length === 2, `expected 2 hops (lead + specialist), got ${run.events.length}: ${JSON.stringify(run.events)}`);
    assert(run.events[1].nodeId === projectAlphaId, `expected routing to ProjectAlpha, got hop to ${run.events[1].nodeId}`);
    assert(
      run.events.every((e: any) => !e.fanoutBatchId),
      "no event should carry a fanoutBatchId for a single-specialist route",
    );
  });

  await testWithRetries("hybrid node: signaling ALL fans out to every branch and reaches the aggregator", async () => {
    const created = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ graphId: hybridGraphId, input: "I need status updates for all projects." }),
    });
    const run = await waitForRun(created.body.id);
    assert(run.status === "completed", `run failed: ${JSON.stringify(run.events)}`);
    assert(run.events.length === 4, `expected 4 hops (lead, 2 branches, aggregator), got ${run.events.length}: ${JSON.stringify(run.events)}`);

    const branchEvents = run.events.filter((e: any) => e.nodeId === projectAlphaId || e.nodeId === projectBetaId);
    assert(branchEvents.length === 2, `expected 2 branch events, got ${branchEvents.length}`);
    assert(
      branchEvents[0].fanoutBatchId && branchEvents[0].fanoutBatchId === branchEvents[1].fanoutBatchId,
      "branch events don't share a fanoutBatchId",
    );

    const aggregatorEvent = run.events.find((e: any) => e.nodeId === hybridAggregatorId);
    assert(aggregatorEvent, "aggregator never ran");
    const output = String(run.output).toLowerCase();
    assert(output.includes("alpha") && output.includes("beta"), `expected the aggregated output to mention both projects, got: ${output.slice(0, 300)}`);
  });

  await test("hybrid node: a new auto edge is automatically added to the ALL fan-out list", async () => {
    const gamma = await api(`/graphs/${hybridGraphId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        name: "ProjectGamma",
        role: "worker",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "You are the engineer for Project Gamma. Reply with one short sentence starting 'Gamma status:'.",
        description: "Handles engineering questions about Project Gamma, a fictional analytics system",
        position: { x: 900, y: 180 },
      }),
    });

    const newEdge = await api(`/graphs/${hybridGraphId}/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeId: leadEngineerId, targetNodeId: gamma.body.id, kind: "auto" }),
    });
    assert(newEdge.status === 201, `failed to create the new auto edge: ${JSON.stringify(newEdge.body)}`);

    const graph = await api(`/graphs/${hybridGraphId}`);
    const lead = graph.body.nodes.find((n: any) => n.id === leadEngineerId);
    assert(
      lead.consensusGroup?.edgeIds?.includes(newEdge.body.id),
      `expected the new edge ${newEdge.body.id} to be auto-added to consensusGroup.edgeIds, got: ${JSON.stringify(lead.consensusGroup)}`,
    );
    assert(graph.body.warnings.length === 0, `expected no coverage warning right after auto-sync, got: ${JSON.stringify(graph.body.warnings)}`);
  });

  // --- Summary ---
  console.log("\n--- Summary ---");
  const passed = results.filter((r) => r.passed).length;
  console.log(`${passed}/${results.length} passed`);
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  FAILED: ${r.name} — ${r.error}`);
  }
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error("e2e runner crashed:", err);
  process.exit(1);
});
