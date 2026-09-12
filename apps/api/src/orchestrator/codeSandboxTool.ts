import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getSandboxProvider, redactSecrets, type SandboxCredentials, type SandboxLanguage } from "@openbots/providers";
import { db } from "../db/client.js";
import { sandboxRuns, userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";

const MAX_SANDBOX_OUTPUT_BYTES = 8_000;
const DEFAULT_SANDBOX_TIMEOUT_MS = 60_000;
const MAX_SANDBOX_TIMEOUT_MS = 120_000;

/** Matches routes/userCredentials.ts's provider naming for a given source. */
export function sandboxCredentialProvider(providerId: string): string {
  return `sandbox_${providerId}`;
}

function getConfiguredTimeoutMs(): number {
  const raw = Number(process.env.SANDBOX_TIMEOUT_MS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SANDBOX_TIMEOUT_MS;
  return Math.min(requested, MAX_SANDBOX_TIMEOUT_MS);
}

/**
 * Deliberately kept well under the default 180s hop timeout — unlike
 * dispatch_to_graph, run_code needs no change to engine.ts's
 * hopTimeoutMsFor/hopDeadlineEpochMs plumbing.
 */
function redactAndCap(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_SANDBOX_OUTPUT_BYTES ? redacted.slice(0, MAX_SANDBOX_OUTPUT_BYTES) : redacted;
}

/**
 * ownerId/nodeId/graphId/runId are bound in by the caller (engine.ts::
 * callAgent) at tool-resolution time — never supplied by the model, same
 * trust boundary dispatch_to_graph/business_metrics/run_remote_command
 * already follow. Dual-gate: the "run_code" tool name AND a non-empty
 * operator env var SANDBOX_PROVIDER (checked fresh on every call, not
 * just at node-save time — same "config is a save-time convenience, not
 * the security boundary" pattern as fileAccessRoot/dispatchTargets).
 */
export function createRunCodeTool(ownerId: string | null, nodeId: string, graphId: string, runId: string): Tool {
  return tool({
    description:
      "Run a short Python or JavaScript snippet in an isolated sandbox with no network access and no " +
      "persistent state across calls. Use for calculations, data transforms, or verifying logic — never for " +
      "anything requiring internet access, file access, or state that must survive between calls.",
    inputSchema: z.object({
      code: z.string().min(1).max(20_000),
      language: z.enum(["python", "javascript"]),
    }),
    execute: async ({ code, language }: { code: string; language: SandboxLanguage }) => {
      const providerId = process.env.SANDBOX_PROVIDER;
      if (!providerId) {
        return { error: "Code execution is not enabled on this server." };
      }
      const provider = getSandboxProvider(providerId);
      if (!provider) {
        return { error: `Unknown SANDBOX_PROVIDER "${providerId}" configured on this server.` };
      }

      let credentials: SandboxCredentials | null = null;
      if (providerId !== "local") {
        if (!ownerId) return { error: "No owner context available for this run." };
        const providerName = sandboxCredentialProvider(providerId);
        const cred = await db.query.userCredentials.findFirst({
          where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, providerName)),
        });
        if (!cred) {
          return {
            error: `No "${providerName}" credential configured yet — add your API key at /settings.`,
            kind: "config",
          };
        }
        // Stored as a bare API key string, not a JSON blob — matches the
        // "github"/"github_ssh_key" single-field CredentialSection
        // pattern (apps/web/app/settings/page.tsx), not the multi-field
        // "metrics_<slug>" JSON-blob pattern, since there's only one
        // field to store here.
        const apiKey = decryptCredential(cred.encryptedKey);
        if (!apiKey) {
          return { error: `The stored "${providerName}" credential is empty — re-save it at /settings.`, kind: "config" };
        }
        credentials = { apiKey };
      }

      const timeoutMs = getConfiguredTimeoutMs();
      const startedAt = new Date();
      let result;
      try {
        result = await provider.runCode(code, language, credentials, timeoutMs);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : "Sandbox execution failed",
          kind: "upstream",
        };
      }

      // Raw, unredacted trail for the account owner (who already has
      // access to their own credentials/run history) — only what
      // reaches the model gets scrubbed, same ordering
      // remoteCommandTool.ts already uses for the same reason.
      await db.insert(sandboxRuns).values({
        runId,
        nodeId,
        graphId,
        provider: providerId,
        language,
        code,
        exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`.trim(),
        startedAt,
        finishedAt: new Date(),
      });

      return {
        stdout: redactAndCap(result.stdout),
        stderr: redactAndCap(result.stderr),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      };
    },
  });
}
