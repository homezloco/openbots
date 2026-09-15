import { and, eq, isNull, or } from "drizzle-orm";
import type { ProviderCredentials } from "@openbots/providers";
import type { ProviderId } from "@openbots/graph-schema";
import { db } from "../db/client.js";
import { providerCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";

/**
 * Resolution order: a node-specific stored credential, then a graph-wide
 * stored credential for the provider, then an environment variable. This
 * lets most self-hosted setups use env vars (Phase 1 default) while still
 * supporting per-agent/per-graph keys (Phase 2) without changing callers.
 */
export async function getCredentials(
  graphId: string,
  nodeId: string,
  providerId: ProviderId,
): Promise<ProviderCredentials> {
  const stored = await db.query.providerCredentials.findFirst({
    where: and(
      eq(providerCredentials.graphId, graphId),
      eq(providerCredentials.provider, providerId),
      or(eq(providerCredentials.nodeId, nodeId), isNull(providerCredentials.nodeId)),
    ),
    // Node-specific (non-null nodeId) must sort first. `desc(nodeId)` looks
    // right but Postgres defaults DESC to NULLS FIRST, so it actually put
    // the graph-wide row first — the exact opposite of the intended
    // precedence, silently: a node with BOTH a node-specific and a
    // graph-wide stored credential always used the graph-wide one. `asc`
    // defaults to NULLS LAST, which is the ordering actually wanted here.
    orderBy: (t, { asc }) => [asc(t.nodeId)],
  });

  if (stored) {
    const apiKey = decryptCredential(stored.encryptedKey);
    if (providerId === "openai-compatible" || providerId === "openrouter") {
      // `|| undefined`, not the raw value: an env var that is SET BUT
      // EMPTY (`OPENAI_COMPATIBLE_BASE_URL=` — exactly what a .env
      // template or CI heredoc produces) would otherwise be handed down
      // as "", which `??` defaulting downstream cannot catch, and
      // `new URL("")` throws a bare "Invalid URL". Found by running the
      // e2e suite against OpenRouter: a node with a STORED openrouter
      // key (rather than the env var) failed with "Invalid URL" instead
      // of reaching the provider at all. Undefined correctly falls
      // through to the adapter's own default base URL.
      return { apiKey, baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || undefined };
    }
    return { apiKey };
  }

  return getCredentialsFromEnv(providerId);
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  xai: "grok-3",
  openrouter: "anthropic/claude-sonnet-4",
  "openai-compatible": "llama3.2",
  mock: "mock-model",
  transform: "template",
};

export function defaultModelFor(providerId: ProviderId): string {
  // openai-compatible fronts arbitrary endpoints whose model ids differ by
  // host (Ollama's "llama3.2" vs Groq's "llama-3.3-70b-versatile" vs a
  // provider's own naming) — the baked-in default only matches Ollama.
  if (providerId === "openai-compatible" && process.env.OPENAI_COMPATIBLE_MODEL) {
    return process.env.OPENAI_COMPATIBLE_MODEL;
  }
  return DEFAULT_MODELS[providerId];
}

function envConfigured(providerId: ProviderId): boolean {
  switch (providerId) {
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "xai":
      return Boolean(process.env.XAI_API_KEY);
    case "openrouter":
      return Boolean(process.env.OPENROUTER_API_KEY);
    case "openai-compatible":
      return Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL);
    case "mock":
      // No network call, no credentials required — see registry.ts.
      return true;
    case "transform":
      // No network call, no credentials required — see registry.ts.
      return true;
  }
}

/**
 * First provider with a usable env key, preferring Anthropic so existing
 * setups keep their current quick-add model. Used by quick-add (the
 * extraction LLM) and the live-reroute example graph so an OpenAI- or
 * Ollama-only box isn't stuck on a hardcoded Anthropic path.
 */
const ENV_PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "xai", "openrouter", "openai-compatible"];

export function pickEnvProvider(): { provider: ProviderId; model: string } | null {
  for (const provider of ENV_PROVIDER_ORDER) {
    if (envConfigured(provider)) return { provider, model: defaultModelFor(provider) };
  }
  return null;
}

/**
 * Every env-configured provider, in the same preference order
 * pickEnvProvider uses internally — not just the first. Used by
 * generateStructured.ts to retry a failed structured-generation call
 * (e.g. a "present but exhausted-credits" key, which envConfigured alone
 * can't detect) against whatever else the operator has configured, rather
 * than giving up after a single hard pick.
 */
export function allEnvConfiguredProviders(): { provider: ProviderId; model: string }[] {
  return ENV_PROVIDER_ORDER.filter(envConfigured).map((provider) => ({ provider, model: defaultModelFor(provider) }));
}

/** Exported for the standalone chat playground, which has no graph/node to scope a stored credential to. */
export function getCredentialsFromEnv(providerId: ProviderId): ProviderCredentials {
  switch (providerId) {
    case "anthropic":
      return { apiKey: requireEnv("ANTHROPIC_API_KEY") };
    case "openai":
      return { apiKey: requireEnv("OPENAI_API_KEY") };
    case "xai":
      return { apiKey: requireEnv("XAI_API_KEY") };
    case "openrouter":
      return { apiKey: requireEnv("OPENROUTER_API_KEY") };
    case "openai-compatible":
      return {
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
        baseURL: requireEnv("OPENAI_COMPATIBLE_BASE_URL"),
      };
    case "mock":
      // No real credential exists or is needed — see registry.ts's mockAdapter.
      return { apiKey: "mock" };
    case "transform":
      // No real credential exists or is needed — see registry.ts's transformAdapter.
      return { apiKey: "transform" };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
