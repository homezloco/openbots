import { generateObject } from "ai";
import { z } from "zod";
import type { FallbackTarget, ProviderId } from "@openbots/graph-schema";
import { getModel } from "@openbots/providers";
import { allEnvConfiguredProviders, getCredentialsFromEnv, pickEnvProvider } from "./credentials.js";

/**
 * Structured LLM generation (the quick-add / promptable-workflow-generation
 * mechanism) with retry-on-failure — the shared piece both routes.js call
 * sites need, extracted rather than each hand-rolling its own loop.
 *
 * pickEnvProvider() alone only proves a key is PRESENT, not that it
 * actually works (found in real use: a present-but-out-of-credits key
 * fails generateObject outright with no retry). Candidate order:
 * pickEnvProvider()'s primary pick, then the caller's own fallback chain
 * (a graph's configured one, when the caller has a graph — empty when
 * generating a brand-new graph that doesn't exist yet), then every other
 * env-configured provider not already tried, as a last resort that needs
 * zero configuration to help. Same "specific → shared → environment-
 * default" resolution shape credentials.ts::getCredentials() already
 * uses for API keys, applied to generation instead.
 */
export async function generateStructuredWithFallback<S extends z.ZodTypeAny>(
  schema: S,
  system: string,
  prompt: string,
  extraFallbackChain: FallbackTarget[] = [],
): Promise<{ object: z.infer<S>; provider: ProviderId; model: string }> {
  const primary = pickEnvProvider();
  if (!primary) {
    throw new Error(
      "No model API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, or OPENAI_COMPATIBLE_BASE_URL in .env, then restart the API.",
    );
  }

  const candidates: { provider: ProviderId; model: string }[] = [primary, ...extraFallbackChain];
  for (const p of allEnvConfiguredProviders()) {
    if (!candidates.some((c) => c.provider === p.provider && c.model === p.model)) candidates.push(p);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const credentials = getCredentialsFromEnv(candidate.provider);
      const model = getModel(candidate.provider, candidate.model, credentials);
      const result = await generateObject({ model, schema, system, prompt });
      return { object: result.object, provider: candidate.provider, model: candidate.model };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Generation failed on every configured provider");
}
