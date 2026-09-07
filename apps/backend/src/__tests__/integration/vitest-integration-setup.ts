/**
 * Pre-import setup for the integration suite. Mirrors
 * `../vitest-env-setup.ts` but pins the env vars the flow tests need
 * (native auth + signing key) so `env.ts`'s zod validate-on-load
 * passes.
 *
 * The suite runs entirely on the ephemeral in-memory document store
 * (`DB_DRIVER=memory`, no file path under NODE_ENV=test) — no
 * external database is required. Each test resets state via
 * `__resetDbForTests()` from `../../db/client.js`.
 *
 * Runs before any test file resolves a module — this file's
 * mutations to `process.env` land before `import { env } from
 * '../env.js'` triggers anywhere in the test graph.
 */

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'silent';

// Loop-native auth needs a signing key (ADR 013). Pin a 32+ char
// fixture so `LOOP_AUTH_NATIVE_ENABLED=true` paths work.
process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
process.env['LOOP_JWT_SIGNING_KEY'] ??= 'integration-test-loop-jwt-signing-key-32-chars-min';

// CTX upstream — the integration tests don't actually call out to
// CTX (order flows are exercised via direct mock-fetch injection),
// but env.ts requires the values.
process.env['GIFT_CARD_API_BASE_URL'] ??= 'http://ctx.test.local';
process.env['GIFT_CARD_API_KEY'] ??= 'integration-test-api-key';
process.env['GIFT_CARD_API_SECRET'] ??= 'integration-test-api-secret';
