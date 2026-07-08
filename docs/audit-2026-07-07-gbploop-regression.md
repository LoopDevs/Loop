# AUDIT-1 GBPLOOP Regression Verification

Date: 2026-07-07

## Result

PASS. The GBPLOOP unbacked-mint P0, CF-08, CF-25, and LOOP-asset peg-break regressions appear fixed in the current tree. This was a read-only verification; no product code change was required.

## Scope

- GBPLOOP unbacked-mint P0 from the wallet/staff stack rebase.
- CF-08 admin step-up scope regression.
- CF-25 redeem-code plaintext/tamper regression.
- LOOP-asset payment currency/peg mismatch regression.

## Evidence

- `apps/backend/src/credits/interest-mint.ts` keeps on-chain interest minting behind `ONCHAIN_MINT_ELIGIBLE_ASSETS = new Set(['GBPLOOP'])`; runtime mintable assets are also filtered through configured issuer-pinned assets and the issuer-signer map.
- `apps/backend/src/credits/payout-asset.ts` maps payout assets from home currency through one shared path and only exposes configured LOOP assets when an issuer is pinned.
- `apps/backend/src/db/schema/payments.ts` and migration `0041_interest_mint_onchain.sql` pin `pending_payouts.kind = 'interest_mint'` rows to `asset_code = 'GBPLOOP'`.
- `apps/backend/src/db/schema/admin.ts` and migration `0041_interest_mint_onchain.sql` pin `interest_mint_snapshots.asset_code` to `GBPLOOP` and enforce snapshot conservation.
- `apps/backend/src/db/migrations/0044_emission_conservation_trigger.sql` installs the cumulative DB trigger that rejects emission / interest-mint materialisation above the un-emitted mirror liability.
- `apps/backend/src/auth/admin-step-up.ts` and `apps/backend/src/auth/admin-step-up-middleware.ts` carry and enforce narrow step-up scopes, including money/admin actions.
- `apps/backend/src/orders/redeem-crypto.ts` encrypts persisted redeem values with an `enc:v1:` AES-256-GCM envelope when `LOOP_REDEEM_ENCRYPTION_KEY` is configured, and rejects tampered encrypted values with `RedeemDecryptError`.
- `apps/backend/src/payments/amount-sufficient.ts` rejects LOOP asset currency mismatches before 1:1 amount comparison, and never over-credits overpayment across currencies.

## Checks Run

- `cd apps/backend && npx vitest run src/credits/__tests__/interest-mint.test.ts src/credits/__tests__/payout-asset.test.ts src/db/__tests__/pending-payouts-schema.test.ts src/admin/__tests__/emissions.test.ts --config vitest.config.ts`
  - Passed: 4 files, 53 tests.
- `cd apps/backend && npx vitest run src/auth/__tests__/admin-step-up.test.ts src/auth/__tests__/admin-step-up-middleware.test.ts src/orders/__tests__/redeem-crypto.test.ts src/orders/__tests__/redeem-crypto-persist.test.ts src/payments/__tests__/watcher.test.ts --config vitest.config.ts`
  - Passed: 5 files, 90 tests.
- `npm run test:integration -w @loop/backend -- src/__tests__/integration/admin-writes.test.ts --reporter=dot`
  - Environment-limited: sandboxed run could not open localhost:5433; unsandboxed run reached Postgres but failed authentication for local user `loop`. This did not produce a product regression signal.

## Residual Risk

The read-only verification confirms the app/schema/migration fences and focused unit coverage in the current tree. A real Postgres integration run for `admin-writes.test.ts` should be repeated once the local integration database credentials match the test harness.
