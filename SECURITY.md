# Security Policy

OpenBots stores model-provider credentials, executes agent tool calls,
and can push code to remotes — so we take security reports seriously.

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub private
vulnerability reporting](../../security/advisories/new) (Security tab →
"Report a vulnerability"). Do **not** open a public issue for a
security problem.

Include enough detail to reproduce: the route, tool, or graph
configuration involved, and what boundary you believe was crossed.

You can expect an acknowledgement within a few days. We'll coordinate
disclosure timing with you once a fix is available.

## Scope notes

Things that are in scope and especially interesting to us:

- Bypasses of `fileAccessRoot` / `resolveWithinRoot` path boundaries
  (including symlink tricks)
- Anything that lets a run write outside its git worktree, or push
  without the literal user-typed `/push` command
- Cross-user access: reading or mutating another user's graphs, runs,
  nodes, or credentials
- Credential leakage: stored keys appearing in API responses, logs,
  hop output, or OTel spans
- Allowlist bypasses (`ALLOWED_FILE_WRITE_ROOTS`,
  `ALLOWED_MCP_SERVERS`, `ALLOWED_SSH_HOSTS`)
- Prompt-injection paths that escalate a tool result into a privileged
  action

Things that are out of scope / by design:

- A malicious model producing bad *content* — agents can be pointed at
  untrusted input, and containment (worktrees, allowlists, no
  LLM-judged pushes) is the mitigation, not model behavior itself
- Attacks requiring an already-authenticated admin/operator
- Self-XSS, missing best-practice headers without demonstrated impact
