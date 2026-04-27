/**
 * Pre-import setup for the integration suite. Mirrors
 * `../vitest-env-setup.ts` but pins env vars at the values the
 * real-DB tests need (active DB, signing key, deposit address) so
 * `env.ts`'s zod validate-on-load passes.
 *
 * Runs before any test file resolves a module — this file's
 * mutations to `process.env` land before `import { env } from
 * '../env.js'` triggers anywhere in the test graph.
 */

// Real DB: docker-compose's `loop_test` (locally) or the postgres
// service container in CI. Either way the URL points at port 5433
// because that's what docker-compose maps locally + the service in
// CI is wired the same way.
process.env['DATABASE_URL'] ??= 'postgres://loop:loop@localhost:5433/loop_test';
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'silent';

// Loop-native auth needs a signing key (ADR 013). Pin a 32+ char
// fixture so `LOOP_AUTH_NATIVE_ENABLED=true` paths work.
process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
process.env['LOOP_JWT_SIGNING_KEY'] ??= 'integration-test-loop-jwt-signing-key-32-chars-min';

// CTX upstream — the integration tests don't actually call out to
// CTX (procurement worker is exercised via direct mock-fetch
// injection), but env.ts requires the value.
process.env['GIFT_CARD_API_BASE_URL'] ??= 'http://ctx.test.local';

// Stellar deposit address — `loopCreateOrderHandler` 503s when this
// is unset for non-credit payment methods. Pin a syntactically-valid
// G-address fixture; the integration test never broadcasts to
// Stellar so the address only needs to satisfy the `STELLAR_PUBKEY_REGEX`.
process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] ??=
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// LOOP-asset issuers (ADR 015) — `payoutAssetFor` returns `null` for
// the issuer when the env var is unset, in which case
// `markOrderFulfilled` skips the `pending_payouts` insert. The
// integration test asserts the payout-intent row landed, so pin a
// fixture issuer per home currency. Same shape as the deposit
// address fixture above.
process.env['LOOP_STELLAR_USDLOOP_ISSUER'] ??=
  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
process.env['LOOP_STELLAR_GBPLOOP_ISSUER'] ??=
  'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
process.env['LOOP_STELLAR_EURLOOP_ISSUER'] ??=
  'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

// Workers stay off — the test drives transitions directly to keep
// timing deterministic.
process.env['LOOP_WORKERS_ENABLED'] = 'false';

// Admin allowlist — mints a CTX-style bearer with `sub=test-admin-id`
// and the admin-handler integration tests assert the full ADR-017
// ladder (idempotency-guarded write + audit envelope + duplicate-
// rejection via partial unique indexes) through real postgres.
process.env['ADMIN_CTX_USER_IDS'] ??= 'test-admin-id';
