# Dogfood: running canweb.net on OpenBots

The plan is to run CanWeb's actual operations through OpenBots, then use
the config, tuning, debugging and analytics that produces to launch
OpenBots for enterprise accounts. This doc is the working contract
between the two codebases — `openbots` (this repo) and `canadian_web`
(the site + CRM + automation loop that runs canweb.net). Each side can
be built independently against it.

## The split

`canadian_web` already runs a real lead-gen machine: contact/intake
forms → AI-drafted proposal (numbers never AI-authored; pricing only
from real Stripe-backed plans) → admin approves → send; a prospect
funnel (Google Places → email-finder → outreach → preview sites → Stripe
fast-track); client portal; and an in-process automation loop (drip
nudges, review requests, referral prompts, weekly growth report, blog
drafts) with a `pending_actions` approval queue. It also exposes a
12-point site audit as `POST /api/v1/audit` and as an MCP server at
`POST /mcp`, both behind `ck_live_` API keys.

**`canadian_web` keeps the deterministic plumbing** — timers, dedupe,
send mechanics, the approval queue, Stripe, email/SMS transport. It is
already the place the human works, so it stays the place the human
approves.

**OpenBots adds judgment** — reading a lead's intake answers and
qualifying them, personalizing outreach beyond templates, triaging the
inbox, reviewing outbound copy before a human sees it, deciding
severity on a failed health check. Every OpenBots output lands in
`canadian_web`'s existing queue; nothing reaches a prospect because an
agent decided it should.

Two hard rules carried over from `canadian_web` that every prompt
below enforces:

- **No AI-authored numbers.** Agents never quote prices, timelines as
  commitments, or metrics they didn't read from a tool. Pricing comes
  from `pricing.ts` in code, in the proposal — not in outreach copy.
- **`qualifiedAt` is a human judgment call, never automated.** Agents
  *recommend* qualification with reasoning; they never set it.

## Where it runs

The Railway deployment (`.railway/railway.ts`), on the account that
holds the CanWeb graphs, with real model keys via account-level BYOK
(Settings → Model API keys). Two operator settings on the `app`
service make the integration possible:

- `ALLOWED_MCP_SERVERS=https://www.canweb.net/mcp` — set 2026-09-15
  via `railway config apply`. Without it no node can be *saved* with
  that MCP server, let alone call it (empty-deny, like every
  `ALLOWED_*` gate).
- Per account, one `user_credentials` row named `canweb_api_key`
  holding a `ck_live_…` key (Settings → MCP server keys). Sent as
  `Authorization: Bearer …`, which is exactly what `canadian_web`'s
  `requireApiKey` expects.

## Workflow 1 — inbound lead ops (build this first, end to end)

Everything else waits until this one runs on real leads for a week.

```
canadian_web (POST /api/intake or /api/contact creates a lead)
  └─ POST https://app-production-7fab.up.railway.app/webhooks/<token>   {event, lead}
       └─ OpenBots run, mode: pinned
            Lead Qualifier ──explicit──▶ Outreach Writer ──explicit──▶ Quality Reviewer ──explicit──▶ CRM Recorder
            (economy)                    (flagship, mcp:audit)          (flagship, gate +1 rev)        (economy, mcp:write)
                                                                                                          └─ canadian_web: crm_notes + pending_actions
```

### Trigger: webhook from `canadian_web`

`canadian_web` posts once per new lead. The run's input is the JSON
body verbatim (see `routes/webhookTriggers.ts` — `createRun(graph,
req.body)`), so the shape below is what the Lead Qualifier reads:

```json
{
  "event": "lead.created",
  "lead": {
    "id": 123,
    "name": "…",
    "email": "…",
    "projectType": "…",
    "budget": "…",
    "timeline": "…",
    "score": "hot | warm | cold",
    "notes": "free text from the intake form, may include their current site URL",
    "language": "en | fr",
    "utmCampaign": "…",
    "createdAt": "2026-09-15T21:00:00Z"
  },
  "website": "https://example.com   (optional — only if the form captured one)"
}
```

Setup: create the trigger in the graph's ⚙️ Webhooks panel (`POST
/graphs/:id/webhooks`, `mode: pinned`); the token is shown exactly
once; `canadian_web` stores it as `OPENBOTS_LEAD_WEBHOOK_URL`
(full URL including the token). Fire-and-forget from `canadian_web`'s
side — the run's result comes back through the MCP write tools below,
not through the webhook response.

### Node 1 — Lead Qualifier (`worker`, tier `economy`, no tools)

System prompt:

> You are the intake qualifier for CanWeb, a Canadian web design and
> digital marketing agency (canweb.net). You receive one new lead as
> JSON. Produce a short qualification brief in exactly this structure,
> in the lead's language (`lead.language`):
>
> ```
> ## Lead #<id> — <name>
> **Fit:** strong | moderate | weak — one sentence why.
> **What they want:** one or two sentences in plain words, from projectType, notes and budget/timeline.
> **Signals:** bullet list — intent signals (specific asks, urgency, an existing site named), concerns (vague scope, unrealistic timeline, budget far below any service, spam patterns).
> **Existing website:** the URL if one is present anywhere in the lead, otherwise "none stated".
> **Recommended service category:** one of: web-design, ecommerce, seo, maintenance, branding, digital-marketing — or "unclear".
> **Recommended next step:** one of: send personalized outreach now | ask a clarifying question first | route to human without outreach (explain) | likely spam (explain).
> ```
>
> Rules: never invent facts not present in the lead. Never quote a
> price, discount, or delivery date. Do not decide whether the lead is
> "qualified" — that is a human decision; you only recommend. Output
> the brief and nothing else.

### Node 2 — Outreach Writer (`worker`, tier `flagship`, tools: `mcp`)

MCP config: `slug: canweb`, `url: https://www.canweb.net/mcp`,
`credentialProvider: canweb_api_key`, `allowedTools: [audit_website]`.

System prompt:

> You write CanWeb's first personal reply to a new inbound lead. Your
> input is a qualification brief. Produce a document in exactly this
> structure, in the lead's language:
>
> ```
> ## Qualification
> (copy the brief's Fit, Recommended service category and Recommended next step lines verbatim)
>
> ## Site audit
> (see below)
>
> ## Email draft
> Subject: …
> (body, plain text, 120–180 words)
>
> ## Talking points
> - three bullets the human can use on a call
> ```
>
> If the brief names an existing website, call `mcp_canweb_audit_website`
> with that URL first and put the score, grade, and the three
> highest-priority fixes under "Site audit", each in one plain-English
> line a non-technical owner understands. If there is no website, write
> "No existing site to audit." and skip the tool.
>
> The email: warm, specific to what they asked for, references at most
> one concrete audit finding as a hook, ends with one clear next step (a
> 15-minute call or a reply with one detail). Sign as Shane Holmes,
> CanWeb. Never quote a price, discount, package, delivery date, or any
> number you did not get from the audit tool. Never promise results
> ("rank #1"). Never mention AI, automation, or that this was drafted.
> If the brief's recommended next step is "route to human" or "likely
> spam", write no email — put the reason under "Email draft" instead.

### Node 3 — Quality Reviewer (`reviewer`, tier `flagship`, no tools)

This is a reviewer gate with the one revision round
(`docs/orchestration.md` → "Reviewer gate and the one revision round"):
its first `NEEDS_REVISION` sends the document back to the Outreach
Writer once; its second verdict is final. The engine injects the
`APPROVED`/`NEEDS_REVISION` convention; the prompt only supplies
judgment criteria.

System prompt:

> You review outbound emails to new leads before a human sees them.
> Reject (NEEDS_REVISION) for any of: a price, discount, timeline
> commitment, or metric not attributable to the audit; a promised
> outcome; a claim about the lead's business that is not in the brief;
> the wrong language; a generic template that could have been sent to
> anyone; length far outside 120–180 words; mention of AI or automation;
> a missing or unclear next step. Otherwise approve. Findings must each
> be one line, specific enough to fix without guessing.

### Node 4 — CRM Recorder (`worker`, tier `economy`, tools: `mcp`)

MCP config: same server, `allowedTools: [add_crm_note, queue_pending_action]`.

System prompt:

> You file a reviewed lead document into CanWeb's CRM. The input is a
> document with a "## Lead #<id>" heading or a "## Qualification"
> section (the lead id is in the document), an "## Email draft" section,
> and possibly a review note at the end.
>
> 1. Call `mcp_canweb_add_crm_note` with the lead id and the
>    Qualification, Site audit and Talking points sections plus the
>    review note, verbatim.
> 2. If "## Email draft" contains a real email (a Subject line and a
>    body), call `mcp_canweb_queue_pending_action` with the lead id,
>    type `send_email`, the subject and the body. If it contains a
>    reason instead of an email, do not queue anything.
> 3. Reply with one line: what you filed and what, if anything, is
>    waiting for approval.
>
> Never edit the email. Never call any other tool.

Edges: Qualifier → Writer, Writer → Reviewer, Reviewer → Recorder, all
`explicit` / `default`. Entry: Lead Qualifier. The Recorder's one-line
reply is the run's output; the run trail holds everything else.

**Why the Recorder is a separate LLM node:** OpenBots has no
deterministic "call these tools with this input" node type (transform
nodes are template/uppercase/extract-json), and the Reviewer can't do
it — a gated reviewer's tool calls would fire before its verdict, and
before the revision round. A narrow prompt on an economy model is the
cheapest correct option today; a `tool_call` transform is the product
gap this exposes.

**Why not a Proposal Drafter:** `canadian_web` already drafts the
proposal on `/api/intake` (`proposal-generate.ts`), with pricing
appended in code. Duplicating that in OpenBots would put numbers in an
LLM's hands. The outreach email is the judgment-heavy artifact the
proposal pipeline doesn't produce.

## MCP tools `canadian_web` exposes (contract)

All on the existing `POST /mcp` server, behind the existing
`requireApiKey`. Model-facing names are `mcp_canweb_<tool>`.

| tool | params | returns | notes |
|---|---|---|---|
| `audit_website` | `{url}` | score, grade, checks, prioritized fixes | exists today |
| `get_lead` | `{id}` | the `leads` row minus `proposalHtml` | read; lets a node re-fetch if the webhook payload was trimmed |
| `add_crm_note` | `{leadId, note}` | `{id}` | writes `crm_notes`, author = the API key's label so agent notes are distinguishable from human ones |
| `queue_pending_action` | `{leadId, type: "send_email", subject, body}` | `{id, status: "pending"}` | writes `pending_actions` exactly as the automation loop's `draft_approve` mode does — never sends |

Invariants the server enforces regardless of what an agent sends:
`qualifiedAt`, `status`, `proposalStatus` are never writable through
MCP; `queue_pending_action` accepts only `send_email` in v1; every call
is attributed to the key. Rate limits are the key tier's existing daily
limit — an agent loop can't exceed what a developer with the same key
could.

## Setup checklist (in order)

1. `canadian_web`: add the three tools above to `server/mcp-server.ts`;
   add the `lead.created` webhook post (env `OPENBOTS_LEAD_WEBHOOK_URL`,
   fire-and-forget, logged on failure).
2. OpenBots account: Settings → MCP server keys → name `canweb_api_key`,
   paste a `ck_live_` key generated for this purpose (label it so its
   CRM notes are recognizable).
3. Create the graph exactly as above (four nodes, three explicit edges,
   entry = Lead Qualifier), create its webhook trigger, copy the token
   into `canadian_web`'s env.
4. Submit a test intake on canweb.net. Expect: one run, four hops (six
   if the reviewer asks for a revision), one CRM note, one pending
   action awaiting approval in `canadian_web`.
5. Run it on real leads for a week before building workflow 2. Tune
   prompts from the run trails; the reviewer's rejection reasons are
   the tuning signal.

## Later workflows (same pattern, not yet designed in detail)

| Workflow | Trigger | Judgment added | Lands in |
|---|---|---|---|
| Outbound sales | daily schedule | personalize outreach beyond the template, per prospect | `pending_actions` |
| Inbox triage | schedule (IMAP read tool) | classify, route to specialist, draft reply | `pending_actions` |
| Client delivery | client conversion | break the sold scope into `tasks` rows | `tasks` |
| Site health | health-check failure webhook | severity call: escalate vs auto-ticket | `tasks` / SMS via Quo |
| Weekly ops review | Monday cron | Stripe summary + growth numbers → reviewed digest | email to Shane |

Each needs its own read/write MCP tools on the `canadian_web` side;
the OpenBots side is the same four-node shape with different prompts.

## What this dogfood is supposed to teach

- Per-hop cost and latency by node tier (`usage_events`), on real work.
- The reviewer's rejection rate and reasons — the prompt-tuning signal,
  and later the enterprise-facing "quality gate" story.
- Failure taxonomy: provider rate limits, MCP timeouts, routing
  dead-ends, revision rounds that didn't converge.
- Time from intake to a human-approvable draft.
- Which product gaps a real business hits first (already: a
  deterministic tool-call node; a generic credential UI — added
  2026-09-15; canvas rendering of `revision_requested`).
