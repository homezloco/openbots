import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { SshTarget } from "@openbots/graph-schema";
import { runSshCommand } from "@openbots/providers";
import { db } from "../db/client.js";
import { remoteCommandRuns, userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";
import { checkSshTargetAllowed } from "../validation/sshTarget.js";

/** Matches routes/userCredentials.ts's provider naming for a given host. */
export function sshCredentialProvider(host: string): string {
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  return `ssh_target_${slug}`;
}

/**
 * Raw known_hosts-format text the operator supplies out-of-band (they run
 * `ssh-keyscan <host>` themselves once) — there's no public key-discovery
 * API for a personal VPS the way GitHub publishes /meta, so this is
 * pinned via an env var rather than ever trusting first-connection TOFU.
 */
function getKnownHosts(): string {
  return process.env.SSH_KNOWN_HOSTS ?? "";
}

/**
 * ownerId/nodeId/graphId/runId/sshTarget are all bound in by the caller
 * (engine.ts::callAgent) at tool-resolution time — never supplied by the
 * model, same trust boundary dispatch_to_graph/business_metrics already
 * follow. The model only ever supplies a commandLabel, matched by exact
 * label against sshTarget.allowedCommands; execute() runs the *stored*
 * command string, never anything the model constructs. sshTarget.host is
 * re-verified fresh against ALLOWED_SSH_HOSTS on every call — never
 * trusted just because it passed validation when the node was last saved.
 */
export function createRunRemoteCommandTool(
  ownerId: string | null,
  sshTarget: SshTarget | null | undefined,
  nodeId: string,
  graphId: string,
  runId: string,
): Tool {
  return tool({
    description:
      "Run one of your pre-approved commands on your configured remote host over SSH. " +
      "You can only select from the exact commands you were told about by label — you cannot " +
      "invent a new command or modify one.",
    inputSchema: z.object({
      commandLabel: z.string().describe("The exact label of one of your pre-approved commands"),
    }),
    execute: async ({ commandLabel }) => {
      if (!ownerId || !sshTarget) {
        return { error: "This agent has no configured remote host." };
      }

      // Re-verified fresh on every call — never trusted from whatever
      // sshTarget said when the node was last saved (same pattern
      // fileAccessRoot/dispatchTargets already follow).
      const rejectionReason = checkSshTargetAllowed(sshTarget);
      if (rejectionReason) {
        return { error: `This agent's remote host is no longer allowed: ${rejectionReason}` };
      }

      const match = sshTarget.allowedCommands.find((c) => c.label === commandLabel);
      if (!match) {
        const labels = sshTarget.allowedCommands.map((c) => c.label).join(", ") || "(none)";
        return { error: `No pre-approved command labeled "${commandLabel}". Valid labels: ${labels}` };
      }

      // A stored key is optional, not required: a host that authenticates
      // without one (e.g. Tailscale SSH, which authenticates the
      // connection at the tailnet level rather than via a classic SSH
      // keypair) has no "ssh_target_<host>" row at all, and that's the
      // expected, working case — not an error. See sshExec.ts.
      const provider = sshCredentialProvider(sshTarget.host);
      const cred = await db.query.userCredentials.findFirst({
        where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, provider)),
      });
      const privateKey = cred ? decryptCredential(cred.encryptedKey) : null;

      const knownHosts = getKnownHosts();
      if (!knownHosts) {
        return { error: "SSH_KNOWN_HOSTS is not configured on the server — the operator must set it before this tool can run." };
      }

      const startedAt = new Date();
      let exitCode: number | null = null;
      let output = "";
      try {
        const result = await runSshCommand(sshTarget.host, sshTarget.username, privateKey, knownHosts, match.command);
        exitCode = result.exitCode;
        output = result.output;
      } catch (err) {
        output = err instanceof Error ? err.message : "SSH command failed";
      }

      await db.insert(remoteCommandRuns).values({
        runId,
        nodeId,
        graphId,
        host: sshTarget.host,
        commandLabel: match.label,
        command: match.command,
        exitCode,
        output,
        startedAt,
        finishedAt: new Date(),
      });

      return { commandLabel: match.label, exitCode, output };
    },
  });
}
