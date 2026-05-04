-- A4-027: add DB-level CHECK constraints on
-- `pending_payouts.asset_code` and `pending_payouts.asset_issuer`.
--
-- Today the app pins both via `payout-builder.ts` (asset_code is
-- one of USDLOOP/GBPLOOP/EURLOOP; asset_issuer is the configured
-- LOOP_STELLAR_<ccy>_ISSUER env). A direct INSERT (admin shell,
-- a future writer that drifts) could land 'BADASSET' or a
-- malformed issuer; the submit worker would round-trip it into
-- Horizon and either silently mis-send or fail unclassified.
-- The matching pubkey shape is the same `^G[A-Z2-7]{55}$`
-- regex already pinned on `to_address` (migration 0024).
--
-- Idempotent: DROP IF EXISTS keeps a partial-apply rerun safe
-- (matches discipline in 0016 / 0029).

ALTER TABLE pending_payouts
  DROP CONSTRAINT IF EXISTS pending_payouts_asset_code_known;

ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_asset_code_known
  CHECK (asset_code IN ('USDLOOP', 'GBPLOOP', 'EURLOOP'));

ALTER TABLE pending_payouts
  DROP CONSTRAINT IF EXISTS pending_payouts_asset_issuer_format;

ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_asset_issuer_format
  CHECK (asset_issuer ~ '^G[A-Z2-7]{55}$');
