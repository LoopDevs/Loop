/**
 * Vitest setup — runs before `config/index.ts` is imported in any test.
 *
 * `config/index.ts` reads and validates the config file at module load, so
 * tests that import anything from the backend need a valid file to
 * exist first. Point `CONFIG_PATH` at the committed placeholder fixture
 * (`apps/backend/config.test.yaml`) rather than letting the loader fall
 * back to `config.yaml` — a developer's real local config must never
 * influence a test run.
 *
 * Running as `setupFiles` (not `globalSetup`) so this lands in every
 * worker process before test-file import resolution happens.
 *
 * Tests that need a *different* setting either mock `../config/index.js` or
 * call `parseConfig()` with a synthetic document; neither needs this
 * file to change.
 */
import { fileURLToPath } from 'node:url';

// Absolute so the fixture resolves the same way regardless of which
// directory vitest happens to run from.
process.env['CONFIG_PATH'] ??= fileURLToPath(new URL('../../config.test.yaml', import.meta.url));
