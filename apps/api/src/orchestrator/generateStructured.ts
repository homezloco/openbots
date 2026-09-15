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
      // OpenAI-compatible json_object mode (which generateObject uses for
      // providers like Groq) hard-rejects the call unless the word "json"
      // literally appears in messages — a provider-side validation, not
      // ours. Appending it here covers every caller; providers that don't
      // require it are unaffected by one extra accurate instruction.
      const systemText = /\bjson\b/i.test(system) ? system : `${system}\n\nRespond with a single JSON object matching the required schema.`;
      const result = await generateObject({
        model,
        schema,
        system: systemText,
        prompt,
        // Same preflight-quota issue as the hop path in engine.ts —
        // Groq's free tier rejects requests whose expected output exceeds
        // its per-minute cap. Unset = provider default, unchanged.
        ...(process.env.MAX_OUTPUT_TOKENS
          ? { maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) }
          : {}),
      });
      return { object: result.object, provider: candidate.provider, model: candidate.model };
    } catch (err) {
      lastError = err;
      // Server-side only — the client still just sees the final error, but
      // without this an operator has no way to tell WHICH candidate(s)
      // failed and why, since only the last one ever reaches the response.
      // Found this blind spot immediately: after fixing one root cause,
      // the next failure in the chain was invisible until this was added.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[generateStructuredWithFallback] ${candidate.provider}/${candidate.model} failed: ${message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Generation failed on every configured provider");
}
