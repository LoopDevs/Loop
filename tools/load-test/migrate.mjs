#!/usr/bin/env node
/**
 * Standalone migration + truncate step for the k6 load-test harness
 * (`tools/load-test/run-local.sh`).
 *
 * `tests/e2e-mocked/global-setup.ts` runs this exact step as a Playwright
 * `globalSetup` hook — but that hook only runs inside a Playwright
 * invocation, and this harness doesn't want to boot a browser or the web
 * dev server just to get a migrated + truncated `loop_test` database. This
 * script imports and calls the SAME default export directly (via `tsx`, so
 * the `.ts` source runs unmodified) — the migrations-folder path and the
 * truncate table list stay defined in exactly one place.
 *
 * Usage: npx tsx tools/load-test/migrate.mjs
 * Requires: `docker compose up -d db` (or an equivalent postgres) already
 * listening at DATABASE_URL (default matches playwright.mocked.config.ts:
 * postgres://loop:loop@localhost:5433/loop_test).
 */
import globalSetup from '../../tests/e2e-mocked/global-setup.js';

await globalSetup();
console.log('[load-test] migrations applied + tables truncated');
