/**
 * Shared GitHub REST API request wrapper — used by both the /pr chat
 * command (routes/runs.ts) and the GitHub tab's PR-status/PR-creation
 * routes (routes/commits.ts), so there's one place that knows how to talk
 * to GitHub's API rather than two copies that could drift.
 */
export async function githubApiRequest(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      // GitHub's API rejects requests with no User-Agent header.
      "User-Agent": "OpenBots",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message ? `GitHub API error: ${body.message}` : `GitHub API request failed with status ${res.status}`);
  }
  return body;
}
