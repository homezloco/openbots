/**
 * Classifies a provider call failure to decide whether a fallback chain
 * should move to the next target — modeled on the visionterm project's
 * ProviderRegistry.generate() classification (see PLAN.md). Only "auth"
 * and "model" errors fall through; anything else (a genuine bad-request
 * from malformed input, for instance) rethrows immediately, since trying
 * the same bad input against a different provider won't help.
 */
export type ProviderErrorClass = "auth" | "model" | "other";

export function classifyProviderError(err: unknown): ProviderErrorClass {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 404) return "model";
  return "other";
}
