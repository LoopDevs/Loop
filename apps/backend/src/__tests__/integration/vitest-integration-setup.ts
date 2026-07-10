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
import { Keypair } from '@stellar/stellar-sdk';

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

// ADR-028 / A4-063: admin step-up signing key. The destructive admin
// endpoints (credit-adjust, emissions, payout-retry) now require a
// fresh `X-Admin-Step-Up` JWT; without the key configured they return
// 503 STEP_UP_UNAVAILABLE. Pin a separate fixture (mirrors the prod
// posture: distinct from LOOP_JWT_SIGNING_KEY) so the integration
// suite can mint step-up tokens via signAdminStepUpToken and exercise
// the gated paths.
process.env['LOOP_ADMIN_STEP_UP_SIGNING_KEY'] ??=
  'integration-test-admin-step-up-key-32-chars-min!';

// CTX upstream — the integration tests don't actually call out to
// CTX (procurement worker is exercised via direct mock-fetch
// injection), but env.ts requires the value.
process.env['GIFT_CARD_API_BASE_URL'] ??= 'http://ctx.test.local';

// Stellar deposit address — `loopCreateOrderHandler` 503s when this
// is unset for non-credit payment methods. Most of the suite only
// needs a value that satisfies `STELLAR_PUBKEY_REGEX` (a text-column
// fixture, never SDK-validated) — but the Q6-6 wallet-spend
// (`orders/redeem.ts`) integration test builds a REAL Stellar
// `Operation.payment` with this as the destination, and the SDK does
// full StrKey checksum validation (unlike the regex), which a
// repeated-character placeholder fails ("destination is invalid").
// A real (never-funded) keypair's public key satisfies both.
process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] ??= Keypair.random().publicKey();

// LOOP-asset issuers (ADR 015) — `payoutAssetFor` returns `null` for
// the issuer when the env var is unset, in which case
// `markOrderFulfilled` skips the `pending_payouts` insert. The
// integration test asserts the payout-intent row landed, so pin a
// fixture issuer per home currency. Same shape as the deposit
// address fixture above.
process.env['LOOP_STELLAR_USDLOOP_ISSUER'] ??=
  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
// GBPLOOP is the one interest-mint-eligible asset (ADR 031 v7 —
// ONCHAIN_MINT_ELIGIBLE_ASSETS). Unlike its USDLOOP/EURLOOP siblings
// above (address-only fixtures — no on-chain minting exercises them),
// the Q6-6 interest-mint integration suite drives
// `runInterestMintTick`, which resolves a real issuer SIGNER via
// `resolveIssuerSigners()` and requires the derived public key to
// match this address exactly (env.ts's ADR-031 cross-field boot
// check, re-asserted defence-in-depth by issuer-signers.ts) — a
// placeholder string address with no matching secret would leave
// GBPLOOP filtered out of `configuredLoopPayableAssets()` and the
// whole mint path a no-op. Generated fresh per process (never
// hardcoded — `scripts/lint-docs.sh` §5b rejects any committed
// `S[A-Z2-7]{55}` literal, and a real keypair proves the boot-time
// derivation check rather than a memorised fixture, same policy as
// `orders/__tests__/redeem.test.ts`). Issuer + secret are set as a
// PAIR, gated on the issuer var alone — independent `??=` on each
// could desync if only one were pre-set externally, which would fail
// the boot-time derived-key match below instead of just no-op'ing.
if (process.env['LOOP_STELLAR_GBPLOOP_ISSUER'] === undefined) {
  const gbploopIssuerKeypair = Keypair.random();
  process.env['LOOP_STELLAR_GBPLOOP_ISSUER'] = gbploopIssuerKeypair.publicKey();
  process.env['LOOP_STELLAR_GBPLOOP_ISSUER_SECRET'] ??= gbploopIssuerKeypair.secret();
}
process.env['LOOP_STELLAR_EURLOOP_ISSUER'] ??=
  'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

// Operator fee-bump signer (ADR 016 / ADR 030 Phase C3). The Q6-6
// wallet-spend (`orders/redeem.ts`) integration suite drives the real
// `redeemLoopOrderHandler`, which 503s NOT_CONFIGURED without this —
// it signs the outer fee-bump envelope wrapping the user's inner
// payment. Same "generate fresh, never hardcode a secret literal"
// policy as the GBPLOOP issuer pair above (`scripts/lint-docs.sh`
// §5b). No cross-field address to match (unlike the issuer pair) —
// only the secret is configured.
process.env['LOOP_STELLAR_OPERATOR_SECRET'] ??= Keypair.random().secret();

// Workers stay off — the test drives transitions directly to keep
// timing deterministic.
process.env['LOOP_WORKERS_ENABLED'] = 'false';

// ADR 031 §D5 (V3) — vault-subsystem master switch, needed by
// `__tests__/integration/vault-emissions.test.ts` so
// `credits/vaults/registry.ts`'s `vaultsEnabled()` (parsed once at
// module load, not re-read live) returns true for the whole suite.
// Harmless to every other integration test — nothing else in the
// suite touches vault code, so this is a pure additive capability,
// same posture as `LOOP_AUTH_NATIVE_ENABLED=true` above. Soroban RPC
// is never actually dialed (that suite mocks `credits/vaults/
// vault-client.js`'s functions) — the URL only needs to satisfy
// env.ts's `LOOP_VAULTS_ENABLED=true` cross-field boot check.
process.env['LOOP_VAULTS_ENABLED'] = 'true';
process.env['LOOP_SOROBAN_RPC_URL'] ??= 'https://soroban-testnet.stellar.org';

// Admin allowlist — mints a CTX-style bearer with `sub=test-admin-id`
// and the admin-handler integration tests assert the full ADR-017
// ladder (idempotency-guarded write + audit envelope + duplicate-
// rejection via partial unique indexes) through real postgres.
process.env['ADMIN_CTX_USER_IDS'] ??= 'test-admin-id';
