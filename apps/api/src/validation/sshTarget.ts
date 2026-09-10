import type { SshTarget } from "@openbots/graph-schema";

/**
 * Operator-level allowlist for run_remote_command — mirrors
 * ALLOWED_FILE_ACCESS_ROOTS/ALLOWED_FILE_WRITE_ROOTS exactly: a node's
 * configured sshTarget must independently be within this allowlist, never
 * trusted just because it was saved. Secure by default: unset means no
 * node can ever be granted this tool at all.
 *
 * Format: comma-separated "username@host" pairs, e.g.
 * "ubuntu@100.66.221.81,deploy@203.0.113.9".
 */
function getAllowedSshTargets(): string[] {
  const raw = process.env.ALLOWED_SSH_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function isAllowedSshTarget(username: string, host: string): boolean {
  return getAllowedSshTargets().includes(`${username}@${host}`);
}

/**
 * Callable directly (not just via zod), same reasoning as
 * checkFileAccessRootAllowed: the cross-graph management tools build
 * plain objects rather than parsing an HTTP request body, so this needs
 * to be invokable from both places without duplicating the check.
 */
export function checkSshTargetAllowed(sshTarget: SshTarget | null | undefined): string | null {
  if (!sshTarget) return null;
  if (!isAllowedSshTarget(sshTarget.username, sshTarget.host)) {
    return "sshTarget must be within an operator-configured host (see ALLOWED_SSH_HOSTS)";
  }
  const labels = new Set<string>();
  for (const { label } of sshTarget.allowedCommands) {
    if (labels.has(label)) return `sshTarget.allowedCommands has a duplicate label: "${label}"`;
    labels.add(label);
  }
  return null;
}
