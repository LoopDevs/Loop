/**
 * Vitest globalSetup — runs before `env.ts` is imported in any test.
 *
 * `env.ts` validates `process.env` at module load, so tests that
 * import anything from the backend must have the required env vars
 * set first. The legacy pattern (prepend-set in each test file) is
 * error-prone and only coincidentally works because every test
 * imports `env.ts` transitively.
 *
 * Running as `setupFiles` (not `globalSetup`) so the vars are set
 * in every worker process before test-file import resolution
 * happens. Placeholders — not real values — since tests don't need
 * a real upstream or database.
 */
if (!process.env['GIFT_CARD_API_BASE_URL']) {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://placeholder-for-tests.local';
}
if (!process.env['DATABASE_URL']) {
  // Valid postgres URL shape — satisfies the zod `.url()` + protocol
  // check in `env.ts`. No test actually opens a connection to this
  // because the tests that do touch the DB mock the `db/client` module.
  process.env['DATABASE_URL'] = 'postgres://placeholder:placeholder@localhost:5433/loop_test';
}
