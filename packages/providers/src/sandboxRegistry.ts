import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";
import { TimeoutError as E2BTimeoutError } from "e2b";
import { CodeLanguage, Daytona, DaytonaProcessExecutionTimeoutError } from "@daytona/sdk";
import type { CodeSandboxProvider, SandboxLanguage, SandboxRunResult } from "./sandboxTypes.js";

/**
 * E2B (Firecracker microVMs). A sandbox's own `timeoutMs` at create()
 * governs its *idle* lifetime, not a single execution's wall-clock time
 * — `runCode`'s own `timeoutMs` is the actual execution bound. Both are
 * set to the same value since we always kill the sandbox in `finally`
 * right after one call, so its idle lifetime never matters beyond that.
 * `allowInternetAccess` defaults to `true` in this SDK — must be set
 * `false` explicitly, never assumed.
 */
const e2bProvider: CodeSandboxProvider = {
  id: "e2b",
  async runCode(code, language, credentials, timeoutMs): Promise<SandboxRunResult> {
    if (!credentials) throw new Error("E2B requires an apiKey credential");
    const sbx = await E2BSandbox.create({
      apiKey: credentials.apiKey,
      timeoutMs,
      allowInternetAccess: false,
    });
    try {
      const execution = await sbx.runCode(code, { language, timeoutMs });
      return {
        stdout: execution.logs.stdout.join(""),
        stderr: execution.logs.stderr.join(""),
        exitCode: execution.error ? 1 : 0,
        timedOut: false,
      };
    } catch (err) {
      if (err instanceof E2BTimeoutError) {
        return { stdout: "", stderr: "", exitCode: null, timedOut: true };
      }
      throw err;
    } finally {
      await sbx.kill();
    }
  },
};

/**
 * Daytona (hosted only since its June 2026 move to a closed platform —
 * see PLAN.md). `process.codeRun`'s `ExecuteResponse` has no separate
 * stderr field (`result` is the command's combined output) — a real SDK
 * limitation, not a bug in this adapter; documented here so it isn't
 * "fixed" by someone assuming stdout/stderr split like the other two
 * providers. Language is set once at sandbox creation, not per call.
 */
const daytonaProvider: CodeSandboxProvider = {
  id: "daytona",
  async runCode(code, language, credentials, timeoutMs): Promise<SandboxRunResult> {
    if (!credentials) throw new Error("Daytona requires an apiKey credential");
    const daytona = new Daytona({ apiKey: credentials.apiKey });
    const sandbox = await daytona.create(
      {
        language: language === "javascript" ? CodeLanguage.JAVASCRIPT : CodeLanguage.PYTHON,
        networkBlockAll: true,
        ephemeral: true,
        autoDeleteInterval: 0,
      },
      { timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) },
    );
    try {
      const result = await sandbox.process.codeRun(code, undefined, Math.max(1, Math.ceil(timeoutMs / 1000)));
      return {
        stdout: result.artifacts?.stdout ?? result.result ?? "",
        stderr: "",
        exitCode: result.exitCode,
        timedOut: false,
      };
    } catch (err) {
      if (err instanceof DaytonaProcessExecutionTimeoutError) {
        return { stdout: "", stderr: "", exitCode: null, timedOut: true };
      }
      throw err;
    } finally {
      await daytona.delete(sandbox);
    }
  },
};

/**
 * Self-hosted Piston (`ghcr.io/engineer-man/piston`), no BYOK credential
 * — the operator's own container, reached over the docker-compose
 * internal network only (never published to the host). Network is
 * disabled per-job by Piston's own `PISTON_DISABLE_NETWORKING` default;
 * this adapter never overrides that.
 */
// Piston uses two different name schemes for the same runtime: package
// install (POST /api/v2/packages) uses "node", but GET /api/v2/runtimes
// and POST /api/v2/execute both use "javascript" (an alias Piston maps
// to the installed node runtime internally) — confirmed live against a
// running container: execute with "node" fails ("node-* runtime is
// unknown"), execute with "javascript" succeeds. This map is for
// execute, so it stays "javascript", not the package-install name.
const PISTON_LANGUAGE: Record<SandboxLanguage, string> = {
  python: "python",
  javascript: "javascript",
};

const localProvider: CodeSandboxProvider = {
  id: "local",
  async runCode(code, language, _credentials, timeoutMs): Promise<SandboxRunResult> {
    const baseUrl = process.env.PISTON_API_URL || "http://sandbox:2000";
    const res = await fetch(`${baseUrl}/api/v2/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: PISTON_LANGUAGE[language],
        version: "*",
        files: [{ content: code }],
        run_timeout: timeoutMs,
        run_cpu_time: timeoutMs,
      }),
    });
    if (!res.ok) {
      throw new Error(`Local sandbox (Piston) execute failed with status ${res.status}`);
    }
    const body = (await res.json()) as {
      run?: { stdout?: string; stderr?: string; code?: number | null; status?: string };
    };
    return {
      stdout: body.run?.stdout ?? "",
      stderr: body.run?.stderr ?? "",
      exitCode: body.run?.code ?? null,
      timedOut: body.run?.status === "TO",
    };
  },
};

const providers: Record<string, CodeSandboxProvider> = {
  e2b: e2bProvider,
  daytona: daytonaProvider,
  local: localProvider,
};

export function getSandboxProvider(id: string): CodeSandboxProvider | undefined {
  return providers[id];
}
