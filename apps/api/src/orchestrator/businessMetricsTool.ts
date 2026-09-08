import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userCredentials } from "../db/schema.js";
import { decryptCredential } from "../auth/crypto.js";

/**
 * Read-only, hardcoded-endpoint sources only — the same "read-only wire
 * protocol in, no control/write path, full stop" rule pc_telemetry
 * already follows (packages/providers/src/tools.ts). Never a POST/PUT/
 * DELETE against anything state-changing on any of these apps.
 *
 * Credential shape (no schema change — user_credentials.encryptedKey
 * already stores an arbitrary string): for leadgen-a/leadgen-b/saas-b the
 * stored value is JSON.stringify({username, password}) for that app's
 * own staff/admin login; the settings-page form JSON-encodes this
 * client-side before POST /me/credentials.
 *
 * "railway" (hosting cost) and revenue endpoints for saas-a/saas-b
 * are NOT implemented here yet — see PLAN.md's business_metrics section
 * for exactly why (Railway needs a real API token to finalize the query
 * against its live GraphQL schema; saas-a/saas-b don't expose
 * revenue via any API today, pending new endpoint code in each app).
 * Adding a new source later is a new case in fetchMetrics() below, not a
 * redesign.
 */

const SOURCES = ["leadgen-a", "leadgen-b", "saas-b"] as const;
type Source = (typeof SOURCES)[number];

interface StoredLogin {
  username: string;
  password: string;
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
 * leadgen-a and leadgen-b are the same codebase (leadgen-b is a fork) —
 * confirmed identical route names/shapes directly in each repo's own
 * server/routes.ts: POST /auth/token (NOT under /api) -> {access_token},
 * then Bearer-authenticated GET /api/admin/dashboard and
 * GET /api/analytics/summary?days=N under the apiRoutes router.
 */
async function fetchLeadgenAStyleDashboard(baseUrl: string, creds: StoredLogin, days?: number) {
  const token = await loginJwt(baseUrl, "/auth/token", creds, "access_token");
  const [dashboard, summary] = await Promise.all([
    getJson(`${baseUrl}/api/admin/dashboard`, token),
    getJson(`${baseUrl}/api/analytics/summary${days ? `?days=${days}` : ""}`, token),
  ]);
  return { dashboard, analyticsSummary: summary };
}

/**
 * saas-b: POST /api/auth/login -> {token, user}, then Bearer-authenticated
 * GET /api/analytics/summary -> {success, data}. Confirmed directly in
 * saas-b's own backend/src/routes/auth.js + controllers/authController.js
 * + routes/analytics.js. Revenue is NOT available here — only Stripe
 * checkout-session creation exists, no revenue/MRR endpoint at all.
 */
async function fetchSaas BSummary(baseUrl: string, creds: StoredLogin) {
  const token = await loginJwt(baseUrl, "/api/auth/login", creds, "token");
  const body = await getJson(`${baseUrl}/api/analytics/summary`, token);
  return {
    usageAndTraffic: body?.data ?? body,
    note: "saas-b has no revenue/MRR endpoint yet — this is usage/traffic only. See PLAN.md.",
  };
}

const SOURCE_BASE_URLS: Record<Source, string> = {
  leadgen-a: "https://www.leadgen-a.example",
  leadgen-b: "https://www.leadgen-b.example",
  saas-b: "https://saas-b.example",
};

async function fetchMetrics(source: Source, creds: StoredLogin, days?: number): Promise<unknown> {
  switch (source) {
    case "leadgen-a":
      return fetchLeadgenAStyleDashboard(SOURCE_BASE_URLS.leadgen-a, creds, days);
    case "leadgen-b":
      return fetchLeadgenAStyleDashboard(SOURCE_BASE_URLS.leadgen-b, creds, days);
    case "saas-b":
      return fetchSaas BSummary(SOURCE_BASE_URLS.saas-b, creds);
  }
}

/**
 * ownerId is bound in by the caller (engine.ts::callAgent) at
 * tool-resolution time, same pattern as dispatch_to_graph — never
 * supplied by the model.
 */
export function createBusinessMetricsTool(ownerId: string | null): Tool {
  return tool({
    description:
      "Get real conversion/revenue/traffic numbers for one of the agency's properties. " +
      "Sources: 'leadgen-a' and 'leadgen-b' (admin dashboard: revenue, MRR, conversion rate, " +
      "traffic), 'saas-b' (usage/traffic only — no revenue data exists for it yet). " +
      "Returns an error naming the missing credential if a source isn't configured — " +
      "never fabricate a number when that happens.",
    inputSchema: z.object({
      source: z.enum(SOURCES),
      days: z.number().int().min(1).max(365).optional().describe("Lookback window for traffic/analytics, if applicable"),
    }),
    execute: async ({ source, days }) => {
      if (!ownerId) return { error: "No owner context available for this run." };

      const provider = `metrics_${source}`;
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
        return await fetchMetrics(source, creds, days);
      } catch (err) {
        return { error: err instanceof Error ? err.message : `Failed to fetch metrics for ${source}` };
      }
    },
  });
}
