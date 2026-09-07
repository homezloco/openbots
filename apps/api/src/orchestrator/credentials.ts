import type { ProviderCredentials } from "@openbots/providers";
import type { ProviderId } from "@openbots/graph-schema";

/**
 * Scaffold-only: one API key per provider from the environment. Phase 2
 * replaces this with per-graph/per-node key management (see PLAN.md) so
 * different agents can use different accounts/keys for the same provider.
 */
export function getCredentials(providerId: ProviderId): ProviderCredentials {
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
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
