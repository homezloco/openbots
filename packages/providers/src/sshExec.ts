import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs `fn` with a pinned known_hosts file and, if `privateKey` is given, a
 * freshly-written mode-0600 private key alongside it — both live only
 * inside a fresh 0700 temp dir for the duration of `fn`, deleted
 * immediately after regardless of outcome. The key is never written into
 * any repo, worktree, or persistent config. `privateKey` is null for a
 * host that authenticates without one (e.g. Tailscale SSH, which
 * authenticates the connection at the tailnet level rather than via a
 * classic SSH keypair) — see run_remote_command, which treats a missing
 * stored credential as exactly that case rather than an error. Shared by
 * gitWorktree.ts's SSH push path (which always has a real key — GitHub
 * has no keyless mode) and run_remote_command (apps/api's
 * remoteCommandTool.ts) — one implementation of "run something over SSH
 * safely," not two.
 */
export async function withEphemeralSshKey<T>(
  privateKey: string | null,
  knownHosts: string,
  fn: (paths: { keyPath: string | null; knownHostsPath: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "openbots-ssh-"));
  try {
    const knownHostsPath = join(dir, "known_hosts");
    await writeFile(knownHostsPath, knownHosts, { mode: 0o600 });
    let keyPath: string | null = null;
    if (privateKey) {
      keyPath = join(dir, "key");
      await writeFile(keyPath, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    }
    return await fn({ keyPath, knownHostsPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Flags shared by every SSH invocation in this codebase: pinned host key
 * (never TOFU — see the known_hosts each caller supplies) and BatchMode so
 * a passphrase/password prompt or host-key mismatch fails fast instead of
 * hanging a worker waiting on input nothing can ever answer. `-i`/
 * IdentitiesOnly are only added when a key is actually supplied — omitting
 * them (rather than pointing at a nonexistent file) is what lets a
 * keyless host's own auth (e.g. Tailscale SSH) take over normally.
 */
function sshFlags(keyPath: string | null, knownHostsPath: string): string[] {
  const flags = ["-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes"];
  if (keyPath) flags.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
  return flags;
}

/** GIT_SSH_COMMAND wants one shell string, not an argv array. */
export function sshCommandFor(keyPath: string | null, knownHostsPath: string): string {
  return `ssh ${sshFlags(keyPath, knownHostsPath).join(" ")}`;
}

export interface SshExecResult {
  exitCode: number;
  output: string;
}

const MAX_OUTPUT_CHARS = 20_000;

/**
 * Runs one exact command on a remote host over SSH. This is for a
 * short-lived admin/reporting command, not a long-running process —
 * output is captured and truncated, never streamed, and a hung command is
 * killed at `timeoutMs`. The command string itself must already be
 * fully-formed and trusted by the caller (see run_remote_command: the
 * model only ever selects a label, never constructs this string).
 * `privateKey` is null for a host with no stored credential — see
 * withEphemeralSshKey.
 */
export async function runSshCommand(
  host: string,
  username: string,
  privateKey: string | null,
  knownHosts: string,
  command: string,
  timeoutMs = 30_000,
): Promise<SshExecResult> {
  return withEphemeralSshKey(privateKey, knownHosts, async ({ keyPath, knownHostsPath }) => {
    const args = [...sshFlags(keyPath, knownHostsPath), `${username}@${host}`, command];
    try {
      const { stdout, stderr } = await execFileAsync("ssh", args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_CHARS * 4,
      });
      return { exitCode: 0, output: `${stdout}${stderr}`.slice(0, MAX_OUTPUT_CHARS) };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message: string };
      if (e.killed) {
        return { exitCode: -1, output: `Command timed out after ${timeoutMs}ms` };
      }
      const combined = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        output: (combined || e.message).slice(0, MAX_OUTPUT_CHARS),
      };
    }
  });
}
