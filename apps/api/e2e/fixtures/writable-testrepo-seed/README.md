This is the seed content for the e2e write-tool test fixture. It gets
copied into a fresh, real git repository (not committed to this repo —
see `apps/api/e2e/setup-writable-fixture.mjs`) before every e2e run, so
tests can safely create real commits and worktrees against it.
