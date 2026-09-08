/**
 * Pre-import setup for the integration suite. Mirrors
 * `../vitest-env-setup.ts` but points `CONFIG_PATH` at
 * `config.integration.yaml`, which turns on Loop-native auth with a
 * signing key so the flow tests can exercise the OTP → JWT → refresh
 * paths (ADR 013).
 *
 * The suite runs entirely on the ephemeral in-memory document store
 * (`database.driver: memory` with an empty `jsonPath`) — no external
 * database is required. Each test resets state via
 * `__resetDbForTests()` from `../../db/client.js`.
 *
 * Runs before any test file resolves a module, so this lands before
 * `import { config } from '../config/index.js'` triggers anywhere in the test
 * graph and reads the file.
 */
import { fileURLToPath } from 'node:url';

// `config/index.ts` lets NODE_ENV override the file's `env:`; vitest already
// sets it to 'test', and the fixture agrees — pinned here so the two
// can't drift if that ever changes.
process.env['NODE_ENV'] = 'test';

process.env['CONFIG_PATH'] ??= fileURLToPath(
  new URL('../../../config.integration.yaml', import.meta.url),
);
