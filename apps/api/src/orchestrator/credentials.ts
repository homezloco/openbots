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
    orderBy: (t, { desc }) => [desc(t.nodeId)], // non-null (node-specific) sorts first
  });

  if (stored) {
    const apiKey = decryptCredential(stored.encryptedKey);
    if (providerId === "openai-compatible" || providerId === "openrouter") {
      return { apiKey, baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL };
    }
    return { apiKey };
  }

  return getCredentialsFromEnv(providerId);
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
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
