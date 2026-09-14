# Launch checklist

Runbook for launching OpenBots publicly. Ordered top to bottom; items
marked **[manual]** are GitHub-settings or machine steps only the
operator can do. The repo is already public — this is about showing up
prepared, not flipping a switch.

## Positioning (keep every post consistent with this)

**Lead with the mechanism:** the canvas stays live while a run
executes. Drag an edge mid-run and the *next hop* follows it. Nobody
else demos this because nobody else's engine re-resolves the graph per
hop. The `docs/assets/openbots-reroute.gif` clip is the entire pitch —
put it first, no preamble.

**One-liner to reuse everywhere:**
> Open-source, self-hosted agent orchestrator whose canvas stays live
> mid-run — reroute a running workflow by dragging an edge.

**Secondary story (credibility):** real dogfooding — the author runs 8
engineering agents that write code into real project repos through
isolated git worktrees, push branches, and open PRs. Every write is
committed per-hop on an `openbots/*` branch; nothing is pushed without
typing a literal `/push`.

**Do not lead with:**
- "n8n for AI agents" — invites a feature-count comparison n8n wins.
- Generic "multi-agent framework" framing — crowded space, no wedge.
- Anything PLAN.md lists as unverified. When asked about a gap, point
  at PLAN.md's honest known-gaps list — that honesty is a selling point
  with this audience, not a weakness.

**Audiences, in priority order:**
1. r/selfhosted — self-hosted + BYOK + Ollama-verified is exactly their
   wheelhouse.
2. r/LocalLLaMA — the zero-cloud-key orchestration angle.
3. Show HN — devs burned by opaque agent builders (Lindy/Gumloop/Zapier
   Agents) and by canvases that go inert (n8n).
4. LangGraph/CrewAI users who want a control surface, not a library.

---

## 1. Pre-launch repo checklist

- [x] Repo public, description set, topics present (incl. `ai-agents`,
      `agent-orchestration`, `ollama`, `workflow-automation`)
- [x] CI badge added to README
- [ ] **[manual]** Social preview image — Settings → General → Social
      preview, 1280×640. A clean Hierarchy-canvas screenshot with the
      logo works; this is what shows when the link is pasted anywhere.
      (Not settable via REST/`gh` — manual upload only.)
- [ ] Repo homepage URL → set once something lives at botmaestro.ai:
      `gh repo edit --homepage https://botmaestro.ai` — skip until real.
- [ ] CI green on main before posting (`e2e` workflow — needs the three
      repo secrets: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
      `E2E_SESSION_SECRET`, `E2E_CREDENTIALS_ENCRYPTION_KEY`). A red
      badge on launch day is avoidable.
- [ ] **[manual]** Fresh-clone smoke test on a machine that has never
      seen this repo: `git clone → corepack enable && pnpm install → cp
      .env.example .env (fill one key + two secrets) → docker compose up
      postgres redis -d --wait → pnpm dev`. Catches README/quickstart
      drift a maintainer is blind to. Any friction found here is what
      every launch visitor hits.
- [ ] Skim `docs/quickstart.md` against the README getting-started —
      they must not contradict each other.
- [ ] **[manual]** Local-install leftovers (not launch blockers):
      re-enter the 3 metrics credentials at /settings; decide on
      `DISABLE_SIGNUP=true` for any internet-reachable install.

## 2. Launch-day sequence

1. Verify CI green. Nothing else matters if the badge is red.
2. **Show HN**, Tue–Thu, ~9am ET. (Drafts below.)
3. **r/selfhosted** same day, after the HN post is live so comments can
   cross-reference.
4. **r/LocalLLaMA** — can be same day or a day later; different angle,
   not a repost.
5. **Product Hunt** — optional. Low effort, low return for dev tools;
   do it the same week or skip it deliberately.
6. The two `docs/blog/` posts are already written — repost to
   dev.to/Medium with canonical links if you want the extra surface.
   `why-you-cant-reroute-a-running-workflow` is the manifesto;
   `giving-agents-write-access-without-losing-sleep` is the trust
   argument. They also work as standalone HN submissions *weeks later* —
   don't burn them all on day one.

## 3. Post drafts

### Show HN

**Title** (under 80 chars):
```
Show HN: OpenBots – steer a running agent workflow by dragging an edge
```

**First comment** (post immediately after submitting):

> Hi HN — I built OpenBots because every agent/workflow tool I tried
> shows you a diagram of a run, but none let you *change* a run while
> it's happening. Here the orchestration graph is the control surface:
> drag an edge to a different node mid-run and the next hop follows it
> (the engine re-resolves the graph fresh after every hop — there's no
> precomputed path to go stale).
>
> It's self-hosted (Postgres + Redis + Docker), model-agnostic BYOK
> (Anthropic/OpenAI/xAI/OpenRouter, or fully local via Ollama — I
> verified a whole graph end-to-end on a local model with no cloud key),
> and multi-user with ownership-scoped access.
>
> The part I care about most: agents that write real code without a
> trust-me license. Every write lands in an isolated git worktree on its
> own branch, auto-committed per hop. Nothing is ever pushed unless I
> literally type /push — matched by regex against my raw input before
> any model involvement. /pr opens a real PR from there.
>
> I've been dogfooding it as the control room for 8 coding agents
> working on my real project repos. Honest status: it works, I use it
> daily, and PLAN.md in the repo keeps a running list of what's verified
> vs. still untested rather than pretending everything is finished.
>
> Repo: https://github.com/homezloco/openbots — the README GIF shows a
> mid-run reroute in ~12 seconds.

### r/selfhosted

**Title:**
```
OpenBots — self-hosted multi-agent orchestration with a canvas you can steer mid-run
```

**Body:**

> I got tired of agent platforms that either hide the graph entirely
> (Lindy/Gumloop/Zapier Agents) or show you a canvas that goes inert the
> moment a run starts (n8n). OpenBots is the opposite: the graph stays
> live during execution, and you can reroute a running workflow by
> literally dragging an edge to a different node.
>
> - Fully self-hosted: Postgres + Redis + two Node services, docker
>   compose included
> - Model-agnostic BYOK: Anthropic, OpenAI, xAI, OpenRouter, or any
>   OpenAI-compatible endpoint — including Ollama, verified end-to-end
>   with no cloud key
> - Agents can read/write real files inside operator-allowlisted roots;
>   writes are isolated to git worktrees, auto-committed per hop, and
>   only pushed when you literally type /push
> - Consensus fan-out routing, scheduled runs, webhook triggers, MCP
>   client support, per-user auth, encrypted credential storage
> - Apache 2.0 (plus a narrow "don't resell it as hosted SaaS" clause)
>
> Demo GIF and docs: https://github.com/homezloco/openbots
>
> Honest caveats: it's one person's project, the e2e suite is real but
> there's no unit-test suite yet, and PLAN.md tracks what's verified vs.
> untested. Would genuinely like feedback on the security model —
> allowing agent file-writes safely was the hardest part.

### r/LocalLLaMA

**Title:**
```
Multi-agent orchestration that runs entirely on Ollama — no cloud key, steerable mid-run
```

**Body:**

> Most agent orchestration tools assume a cloud API. OpenBots works
> fully local: point the `openai-compatible` provider at
> `http://localhost:11434/v1` and every node in a graph runs on your
> local model. I ran a real multi-hop graph end-to-end on a local model
> with zero API keys configured.
>
> What makes it unusual: the routing graph is a live canvas. Auto-routed
> agents pick their next hop by name/description match, consensus nodes
> fan out to specialists and aggregate, and while a run is executing you
> can drag an edge to a different node — the next hop follows the new
> route (the engine re-resolves after every hop rather than planning the
> run upfront).
>
> File tools are scoped per-agent to operator-allowlisted roots, writes
> go into isolated git worktrees, and nothing pushes without an explicit
> /push command — relevant if you let local models loose on real files.
>
> Self-hosted (compose up), Apache 2.0:
> https://github.com/homezloco/openbots

## 4. Anticipated Q&A (pre-drafted, honest)

**"How is this different from n8n?"**
> n8n can highlight nodes as a workflow runs, but edits apply to the
> *next* execution — you can't steer the one in flight. OpenBots'
> engine has no precomputed path at all: each hop re-reads the graph
> fresh, so an edit mid-run takes effect on the very next hop. The
> canvas is the control surface, not a visualization.

**"Why not LangGraph + LangSmith?"**
> LangGraph is a code library — you write Python to define the graph,
> and LangSmith shows you traces after the fact. OpenBots is the
> complement: a live control surface where the graph itself is the
> editable object. If you want to write orchestration in code, LangGraph
> is right; if you want to watch and steer it, this is.

**"Letting agents write to real repos sounds dangerous."**
> It is, which is why it's the most engineered part: dual operator
> allowlists (a node having read access never implies write), every
> write isolated to a git worktree on an `openbots/*` branch, per-hop
> auto-commits, and pushes/PRs gated on literal regex-matched `/push`
> and `/pr` commands typed by the human — never an LLM's judgment call,
> never triggerable by anything an agent read. There's a blog post in
> docs/blog/ on exactly this.

**"The license isn't pure Apache?"**
> Apache 2.0 plus one clause: you can't run a hosted multi-tenant
> OpenBots-as-a-service for third parties without a commercial
> agreement. Everything else — self-host, modify, fork, run for your org
> or a consulting client — is free. It's the standard "don't clone me
> into a SaaS" protection.

**"Is there a hosted version / demo?"**
> Self-hosted only today. The README GIF shows the flagship feature in
> ~12s and `pnpm dev` + compose gets you a running stack in a few
> minutes; a hosted demo instance is the gap being worked. (See §5.)

**"Token cost of running agents?"**
> Every hop is usage-tracked with real per-provider pricing including
> prompt-cache token breakdowns, so you can see what a run actually
> cost. For zero marginal cost, run the whole graph on Ollama.

## 5. Hosted demo — spec for later (not a launch blocker)

Launch carries on the committed GIFs + the in-app "Try the live-reroute
demo" button. If a real "try it now" link becomes worth it:

- **Shape:** one Railway service running api+worker in the same
  container (they must share a filesystem — `/push`, commit diffs, and
  PR-status exec `git` in the API process against worktrees the worker
  creates; Railway volumes are per-service), plus Railway Postgres and
  Redis plugins.
- **Domains:** `app.botmaestro.ai` + `api.botmaestro.ai`, NOT default
  `*.up.railway.app` — `up.railway.app` is on the Public Suffix List, so
  those two are different "sites" and the `SameSite=Lax` session cookie
  won't be sent on cross-site fetches. Subdomains of one domain are
  same-site; works with zero code changes. Set `COOKIE_SECURE=true`,
  `WEB_ORIGIN=https://app.botmaestro.ai`.
- **Build arg:** `NEXT_PUBLIC_API_URL` is inlined at Next.js build time
  — the web Dockerfile needs an `ARG`/`ENV` pair so Railway can inject
  `https://api.botmaestro.ai` during the image build.
- **Cost guard:** seed one demo account, set `DISABLE_SIGNUP=true`, and
  pin every demo-graph node to a free/cheap model (local Ollama on the
  VPS or an OpenRouter free-tier model) — never the operator's Anthropic
  key. Open signup + env provider keys = strangers billing runs to you.
- **Omit on the demo:** file tools entirely (no repos to clone, no
  volume needed), `pc_telemetry`, local Piston sandbox.
- **Cheaper alternative that converts nearly as well:** a 60-second
  narrated screen capture. One evening, no deployment.

## 6. Post-launch routine

- **First 6 hours:** answer every comment fast — early reply velocity
  visibly affects HN ranking and reddit thread survival.
- **48 hours:** fold recurring questions into a README FAQ section.
- **Ongoing:** triage issues within a day; label honest `good first
  issue`s. CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md already
  exist.
- **Measure:** GitHub traffic/stars are the only real signal; note the
  day-one spike source so you know which channel worked.
- **Slow-burn follow-ups (weeks after, not day one):** submit the two
  blog posts to HN as standalone stories; add comparison content
  ("n8n AI agent alternative") to docs once there's search surface.
