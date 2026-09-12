# Quickstart

You just cloned the repo. This is the fastest way to get OpenBots running
and see what it does. It doesn't cover architecture — that's
`docs/orchestration.md` (the engine, routing, mid-run reroute) and
`docs/adapters.md` (providers, credentials, tools).

Prerequisites either way: Node with `corepack enable` (for pnpm) and
Docker.

## Path 1: Fastest — Postgres/Redis in Docker, everything else local

This is the path in the main README.

```bash
corepack enable
pnpm install
cp .env.example .env
```

Fill in at least one model key in `.env` (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `XAI_API_KEY`, or `OPENROUTER_API_KEY`), plus the two
generated secrets:

```bash
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> CREDENTIALS_ENCRYPTION_KEY
```

If you don't want to use any of those providers, skip the key for now —
see Path 2 below.

```bash
docker compose up postgres redis -d --wait
pnpm dev   # web + api + worker. The API applies migrations on boot.
```

Sign up at `http://localhost:3000/login`. On the Dashboard, click **Try
the live-reroute demo** — that's the graph in the README's GIF. Leave
**Live** mode checked, start a run, and drag the Router's outgoing edge
onto Billing while Router is still generating mid-hop.

## Path 2: Zero API key — run fully local with Ollama

You don't need to sign up for any provider to try OpenBots. The
`openai-compatible` provider talks to anything that speaks the OpenAI
chat-completions wire format, including a local Ollama install.

1. Install and run [Ollama](https://ollama.com), pull a model:
   ```bash
   ollama pull llama3.1
   ```
2. In `.env`, set:
   ```bash
   OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
   OPENAI_COMPATIBLE_API_KEY=anything
   ```
   Ollama doesn't check the key, so any non-empty string works — it just
   needs to be present.
3. Follow the rest of Path 1 (`docker compose up postgres redis -d --wait`,
   `pnpm dev`, sign up).
4. When you create or edit an agent, set its provider to
   `openai-compatible` and its model to whatever you pulled (e.g.
   `llama3.1`). Provider and model are per-node — one agent can run
   against Ollama while another in the same graph uses Anthropic or
   OpenAI, as long as you've set the matching key/URL.

Nothing leaves your machine on this path: no model key, no external API
call.

## Path 3: Full Docker — everything containerized

If you'd rather not run `pnpm dev` locally at all:

```bash
cp .env.example .env
# fill in the same keys/secrets as above
docker compose up postgres redis api worker -d
```

The API container applies migrations on start; the worker container
waits until `/health` is up before it starts pulling jobs. This also
starts a small `mcp-echo` fixture service used by the e2e suite — you
only need to care about it if you're wiring up MCP servers locally (see
`docs/adapters.md`).

To also containerize the frontend:

```bash
docker compose up --build web
```

If your network is flaky pulling large packages (`next`,
`@next/swc-*`) inside the build, run the web app locally against the
dockerized API instead — this works just as well:

```bash
pnpm --filter @openbots/web build
pnpm --filter @openbots/web start
```

## First 10 minutes

Once you're signed in, in roughly this order:

1. **Try the live-reroute demo** (Dashboard). Start a run in **Live**
   mode, then drag the Router's outgoing edge onto Billing while it's
   still generating. Watch the next hop follow the new target instead of
   the original one.
2. **Try the agency demo** (Dashboard). This sets up a fictional Acme
   Portfolio with dashed "gateway" nodes. Click one — it opens that
   team's own Hierarchy canvas (Payments or Platform), not a modal.
3. **Describe a bot in plain English**. Click "+ New bot" on the
   Dashboard and describe what it should do (e.g. "summarizes support
   tickets"). A master-agent flow fills in its role, system prompt, and
   model — you can still edit everything by hand afterward.
4. **Check `/settings`**. Account-level secrets — GitHub PAT/SSH key
   (for `/push` and `/pr`) and `metrics_<slug>` logins for
   `business_metrics` — live there, not on individual agents. They're
   stored encrypted and never returned by any API response.

## Troubleshooting

- **Runs stay `pending` forever.** The API only *enqueues* hops; the
  worker *runs* them. `pnpm dev` starts both, but if you're running
  pieces individually (or in Docker) and forgot the worker, this is the
  first thing to check.
- **The web app can't reach the API, or you get CORS errors in the
  console.** The web app expects the API on `http://localhost:4000`, and
  the API's CORS config is driven by `WEB_ORIGIN` in `.env` (defaults to
  `http://localhost:3000`). If you're serving the frontend from anywhere
  else, update `WEB_ORIGIN` to match.
- **Redis port confusion.** `.env.example` points at `localhost:6380`
  because `docker compose` publishes Redis there on purpose, to avoid
  clashing with a local Redis already on `6379`. Inside compose, the
  api/worker containers still talk to `redis:6379` — you don't need to
  change anything unless you're connecting to Redis directly from the
  host.

For how any of this actually works under the hood — the orchestration
engine, routing/reroute semantics, provider adapters, credentials, tools —
see `docs/orchestration.md` and `docs/adapters.md`.
