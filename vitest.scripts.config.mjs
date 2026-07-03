import { defineConfig } from 'vitest/config';

/**
 * Root-level tests for repo tooling under `scripts/` (e.g. the D3
 * endpoint scaffold generator). The three package workspaces each run
 * their own vitest; repo-root scripts have no workspace, so this config
 * gives them a home. Wired into `npm test` via `test:scripts`.
 */
export default defineConfig({
  test: {
    include: ['scripts/__tests__/**/*.test.mjs'],
  },
});
