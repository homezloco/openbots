import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";

/**
 * Read-only sources only — the same "read-only wire protocol in, no
 * control/write path, full stop" rule pc_telemetry already follows
 * (packages/providers/src/tools.ts). Never a POST/PUT/DELETE against
 * anything state-changing on any source.
 *
 * Sources are user-configured, not hardcoded: a "metrics_<slug>"
 * user_credentials row (any slug the user picks at /settings) stores
 * JSON.stringify({username, password, baseUrl, style}) — no schema
 * change, user_credentials.encryptedKey already stores an arbitrary
 * string. "style" selects which of the two known integration shapes
 * below to speak (see fetchMetrics()); adding a genuinely new shape
 * later is a new case there, not a redesign. Previously this file
 * hardcoded three of the maintainer's own personal-project domains
 * directly in source — moved to per-user config so the OSS default has
 * no site names baked in.
 */

export const METRICS_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const METRICS_STYLES = ["dashboard", "login"] as const;
export type MetricsStyle = (typeof METRICS_STYLES)[number];

export function metricsSourceProvider(slug: string): string {
  return `metrics_${slug}`;
}

interface StoredLogin {
  username: string;
  password: string;
  baseUrl: string;
  style: MetricsStyle;
}

async function loginJwt(baseUrl: string, path: string, creds: StoredLogin, tokenField: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) {
    throw new Error(`Login to ${baseUrl} failed with status ${res.status}`);
  }
  const body: any = await res.json();
  const token = body?.[tokenField];
  if (typeof token !== "string" || !token) {
    throw new Error(`Login to ${baseUrl} succeeded but no "${tokenField}" field was in the response`);
  }
  return token;
}

async function getJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed with status ${res.status}`);
  }
  return res.json();
}

/**
 * "dashboard" style: POST /auth/token (NOT under /api) -> {access_token},
 * then Bearer-authenticated GET /api/admin/dashboard and
 * GET /api/analytics/summary?days=N. Revenue/MRR/conversion + traffic.
 */
async function fetchDashboardStyle(baseUrl: string, creds: StoredLogin, days?: number) {
  const token = await loginJwt(baseUrl, "/auth/token", creds, "access_token");
  const [dashboard, summary] = await Promise.all([
    getJson(`${baseUrl}/api/admin/dashboard`, token),
    getJson(`${baseUrl}/api/analytics/summary${days ? `?days=${days}` : ""}`, token),
  ]);
  return { dashboard, analyticsSummary: summary };
}

/**
 * "login" style: POST /api/auth/login -> {token, user}, then
 * Bearer-authenticated GET /api/analytics/summary -> {success, data}.
 * Usage/traffic only — no revenue/MRR endpoint in this shape.
 */
async function fetchLoginStyleSummary(baseUrl: string, creds: StoredLogin) {
  const token = await loginJwt(baseUrl, "/api/auth/login", creds, "token");
  const body = await getJson(`${baseUrl}/api/analytics/summary`, token);
  return {
    usageAndTraffic: body?.data ?? body,
    note: "This source has no revenue/MRR endpoint configured — usage/traffic only.",
  };
}

async function fetchMetrics(creds: StoredLogin, days?: number): Promise<unknown> {
  if (!creds.baseUrl || !creds.style) {
    throw new Error(
      "This metrics credential is missing baseUrl and/or style — re-save it at /settings as JSON {username, password, baseUrl, style} (style is \"dashboard\" or \"login\").",
    );
  }
  switch (creds.style) {
    case "dashboard":
      return fetchDashboardStyle(creds.baseUrl, creds, days);
    case "login":
      return fetchLoginStyleSummary(creds.baseUrl, creds);
  }
}

export interface MetricsSource {
  slug: string;
  label: string;
}

/**
 * Mirrors dispatchTool.ts's getDispatchableGraphs: a node with
 * business_metrics has zero built-in knowledge of which sources this
 * owner has actually configured, so engine.ts uses this to inject that
 * list into the system prompt (appendMetricsSourcesContext) — the
 * model is never expected to guess a slug.
 */
export async function getMetricsSources(ownerId: string | null): Promise<MetricsSource[]> {
  if (!ownerId) return [];
  const rows = await db.query.userCredentials.findMany({
    where: and(eq(userCredentials.userId, ownerId), like(userCredentials.provider, "metrics_%")),
  });
  return rows.map((r) => ({ slug: r.provider.slice("metrics_".length), label: r.label || r.provider }));
}

/**
 * ownerId is bound in by the caller (engine.ts::callAgent) at
 * tool-resolution time, same pattern as dispatch_to_graph — never
 * supplied by the model.
 */
export function createBusinessMetricsTool(ownerId: string | null): Tool {
  return tool({
    description:
      "Get real conversion/revenue/traffic numbers for a metrics source configured at " +
      "/settings. 'source' is the name the source was given when its credential was saved — " +
      "see the list of configured sources in your instructions, or ask the user to add one " +
      "at /settings if none is listed. Returns an error naming the missing credential if a " +
      "source isn't configured — never fabricate a number when that happens.",
    inputSchema: z.object({
      source: z
        .string()
        .min(1)
        .regex(METRICS_SLUG_PATTERN, "source must be the lowercase slug it was configured with at /settings"),
      days: z.number().int().min(1).max(365).optional().describe("Lookback window for traffic/analytics, if applicable"),
    }),
    execute: async ({ source, days }) => {
      if (!ownerId) return { error: "No owner context available for this run." };

      const provider = metricsSourceProvider(source);
      const cred = await db.query.userCredentials.findFirst({
        where: and(eq(userCredentials.userId, ownerId), eq(userCredentials.provider, provider)),
      });
      if (!cred) {
        return { error: `No "${provider}" credential configured yet — add one at /settings.` };
      }

      let creds: StoredLogin;
      try {
        creds = JSON.parse(decryptCredential(cred.encryptedKey));
      } catch {
        return { error: `The stored "${provider}" credential is malformed — re-save it at /settings.` };
      }

      try {
        return await fetchMetrics(creds, days);
      } catch (err) {
        return { error: err instanceof Error ? err.message : `Failed to fetch metrics for ${source}` };
      }
    },
  });
}
