import { tool, type Tool } from "ai";
import { z } from "zod";
import { assertPublicUrl } from "./publicUrl.js";
import { redactSecrets } from "./redact.js";

/**
 * Native open-web research: `web_search` (find pages) and `web_fetch`
 * (read one). MCP remains a fully supported alternative — several hosted
 * search MCP servers exist and need no code here — but native is the
 * default so a self-hosted install can do research without depending on
 * a third-party MCP host.
 *
 * These are the only tools that reach ARBITRARY hosts. Every other
 * outbound tool (`http_request`, `mcp`, `business_metrics`) is confined
 * by an operator allowlist; research can't be, so the boundary is
 * inverted into a private-range denylist — see publicUrl.ts for exactly
 * what that does and does not guarantee.
 */

const MAX_FETCH_BYTES = 40_000;
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  id: string;
  /** Whether the operator has configured what this backend needs. */
  configured(): boolean;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/**
 * One adapter per backend, selected by WEB_SEARCH_PROVIDER — the same
 * "not a forced single vendor" shape as sandboxRegistry's e2b/daytona/
 * local. Adding a backend is one object here, not a change to the tool.
 */
const braveProvider: SearchProvider = {
  id: "brave",
  configured: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
  async search(query, limit) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY ?? "",
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (body.web?.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  },
};

const tavilyProvider: SearchProvider = {
  id: "tavily",
  configured: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, limit) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: limit }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  },
};

const SEARCH_PROVIDERS: Record<string, SearchProvider> = {
  brave: braveProvider,
  tavily: tavilyProvider,
};

export function getSearchProvider(): SearchProvider | null {
  const id = process.env.WEB_SEARCH_PROVIDER;
  if (!id) return null;
  return SEARCH_PROVIDERS[id] ?? null;
}

/**
 * Strips a fetched page down to readable text. Deliberately crude: no
 * DOM parser dependency, since the model only needs prose, and a
 * half-parsed page costs a retry rather than correctness.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function cap(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_FETCH_BYTES ? `${redacted.slice(0, MAX_FETCH_BYTES)}\n[...truncated]` : redacted;
}

/**
 * Dual-gated like every other capability: the tool name on the node AND
 * an operator-configured WEB_SEARCH_PROVIDER with its API key present.
 * Empty/unset means no node can search, however configured.
 */
export function createWebSearchTool(): Tool {
  return tool({
    description:
      "Search the public web and return ranked results (title, url, snippet). Use to FIND pages; use web_fetch to read one. " +
      "Snippets are search-engine summaries, not verified facts — fetch the page before relying on a detail.",
    inputSchema: z.object({
      query: z.string().min(1).max(400),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ query, limit }: { query: string; limit: number }) => {
      const provider = getSearchProvider();
      if (!provider) return { error: "Web search is not enabled on this server." };
      if (!provider.configured()) {
        return { error: `Web search provider "${provider.id}" has no API key configured on this server.`, kind: "config" };
      }
      try {
        const results = await provider.search(query, limit);
        if (results.length === 0) return { results: [], note: "No results." };
        return { results: results.map((r) => ({ ...r, snippet: cap(r.snippet) })) };
      } catch (err) {
        return { error: redactSecrets(err instanceof Error ? err.message : String(err)), kind: "upstream" };
      }
    },
  });
}

/**
 * Reads one public page as text. Separate from `http_request` on purpose:
 * that tool's guarantee is "only operator-allowlisted hosts", and reusing
 * it for arbitrary URLs would silently destroy that guarantee for every
 * node that has it.
 */
export function createWebFetchTool(): Tool {
  return tool({
    description:
      "Fetch one public web page and return its readable text. Only public internet addresses; " +
      "internal/private hosts are refused. Use after web_search to verify a detail at its source.",
    inputSchema: z.object({
      url: z.string().url(),
    }),
    execute: async ({ url }: { url: string }) => {
      const check = await assertPublicUrl(url);
      if (!check.ok) return { error: `Refused to fetch ${url}: ${check.reason}.` };

      let res: Response;
      try {
        res = await fetch(url, {
          // Redirects are refused rather than followed: a public URL that
          // 302s to 169.254.169.254 would otherwise walk straight past the
          // check above, which only ever saw the original hostname.
          redirect: "error",
          headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        return { error: redactSecrets(err instanceof Error ? err.message : String(err)), kind: "upstream" };
      }

      if (!res.ok) return { error: `HTTP ${res.status} from ${url}`, status: res.status };

      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/|json|xml/i.test(contentType)) {
        return { error: `Unsupported content-type "${contentType}" — only text-like responses are read.` };
      }

      const raw = await res.text().catch(() => "");
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw;
      return { url, contentType, text: cap(text) };
    },
  });
}
