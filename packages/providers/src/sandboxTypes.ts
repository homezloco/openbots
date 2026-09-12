export type SandboxLanguage = "python" | "javascript";

export interface SandboxCredentials {
  apiKey: string;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * One interface, three backends (e2b/daytona/local-Piston) — mirrors
 * ProviderAdapter's "one interface per LLM provider" shape in types.ts.
 * No capability-flags object here: unlike LLM providers, all three
 * sandbox backends are identical on every axis that would matter today
 * (stateless per call, no network) so a flags object would carry no
 * real variance yet — add one if a provider genuinely diverges later.
 */
export interface CodeSandboxProvider {
  id: "e2b" | "daytona" | "local";
  /** null for "local" — no BYOK needed, it's the operator's own container. */
  runCode(
    code: string,
    language: SandboxLanguage,
    credentials: SandboxCredentials | null,
    timeoutMs: number,
  ): Promise<SandboxRunResult>;
}
