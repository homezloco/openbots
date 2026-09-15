import { defineRailway, github, postgres, preserve, project, redis, service, volume } from "railway/iac";

// Hosted demo topology for OpenBots — see docs/launch-checklist.md §5.
//
// `app` runs the API AND BullMQ worker in one container
// (scripts/serve-both.mjs): agent write tools create git worktrees that
// the worker writes and the API later reads for /push, /pr, and commit
// diffs, and Railway volumes are per-service — two services could never
// share that directory. The seeded demo repo lives in the app-data
// volume at /data/demo-repo (created on first boot).
//
// No provider env keys except OPENAI_COMPATIBLE_* pointed at a free-tier
// endpoint (set via `railway variable set`, preserved here) — open
// signup means any visitor's run could otherwise bill to a paid env key.
// All ALLOWED_* gates left unset = those tools simply can't be granted.
export default defineRailway(() => {
  const openbots = github("homezloco/openbots", { checkSuites: false });

  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const Redis = redis("Redis", { region: "us-west2" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const appData = volume("app-data", { allowOnlineResize: true, region: "us-west2", sizeMB: 1024 });

  const app = service("app", {
    source: openbots,
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile" },
    start: "node scripts/serve-both.mjs",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
    volumeMounts: { "/data": appData },
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      REDIS_URL: Redis.env.REDIS_URL,
      WEB_ORIGIN: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
      // web and api live on separate *.up.railway.app domains, which are
      // cross-site (the suffix is on the Public Suffix List) — the session
      // cookie must be SameSite=None;Secure to survive. Switch to "lax"
      // (or delete) when moving to app./api.<domain> subdomains.
      COOKIE_SECURE: "true",
      COOKIE_SAMESITE: "none",
      ALLOWED_FILE_ACCESS_ROOTS: "/data/demo-repo",
      ALLOWED_FILE_WRITE_ROOTS: "/data/demo-repo",
      // The CanWeb dogfood (docs/dogfood-canweb.md): nodes reach
      // canadian_web's MCP server (audit + lead tools) behind a ck_live_
      // key stored per account as user_credentials "canweb_api_key".
      // Prefix allowlist, same empty-deny shape as the file roots above.
      ALLOWED_MCP_SERVERS: "https://www.canweb.net/mcp",
      DEMO_REPO_DIR: "/data/demo-repo",
      WORKTREE_RETENTION_HOURS: "72",
      // Groq free tier — the only env-configured provider, so generateGraph/
      // quick-add work for every visitor while paid spend is impossible.
      OPENAI_COMPATIBLE_BASE_URL: "https://api.groq.com/openai/v1",
      // gpt-oss-120b for env-provider picks (generation/quick-add): its
      // reasoning_content quirk only breaks multi-turn tool loops, which
      // generation never is. Demo graphs should pin tool-using nodes to
      // qwen/qwen3.8-27b explicitly per-node.
      OPENAI_COMPATIBLE_MODEL: "openai/gpt-oss-120b",
      OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS: "true",
      // Scoped to openai-compatible only; BYOK visitors on Anthropic/
      // OpenAI keys are never capped by this. Was 950 (Groq free tier's
      // ~1000 output-tokens/minute); raised live to 6000 once the demo
      // pipelines' status reports outgrew it — reconciled here 2026-09-15
      // so `railway config apply` stops trying to revert it.
      OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS: "6000",
      // Secrets — real values set via `railway variable set`, never in source.
      SESSION_SECRET: preserve(),
      CREDENTIALS_ENCRYPTION_KEY: preserve(),
      OPENAI_COMPATIBLE_API_KEY: preserve(),
    },
  });

  const web = service("web", {
    source: openbots,
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/web/Dockerfile" },
    replicas: { "us-west2": 1 },
    env: {
      // Dockerfile declares ARG NEXT_PUBLIC_API_URL — Railway passes
      // service variables as Docker build args, so this reaches the
      // Next.js build where it's inlined into the client bundle.
      NEXT_PUBLIC_API_URL: "https://${{app.RAILWAY_PUBLIC_DOMAIN}}",
    },
  });

  return project("openbots", {
    resources: [app, Postgres, Redis, web, postgresVolume, redisVolume, appData],
  });
});
