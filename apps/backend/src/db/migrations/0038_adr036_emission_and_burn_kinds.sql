-- ADR 036 — cashback-mode token lifecycle: emission + burn payout kinds.
--
-- 1. `kind='withdrawal'` rows are re-labelled `kind='emission'`. ADR 036
--    re-scopes the ADR-024 "withdrawal writer" to an *emission* primitive:
--    sending LOOP to a user backfills the on-chain half of an existing
--    `user_credits` liability and therefore never debits the mirror.
--    ("Withdrawal" as a user-facing concept now exclusively means the
--    future fiat-out *redemption* rail.) Rows written before this
--    migration carried an at-send debit (`credit_transactions` row with
--    `type='withdrawal'` referencing the payout id) — that ledger row is
--    retained untouched and is what discriminates a legacy debited
--    emission (compensable on permanent failure) from a post-ADR-036
--    emission (nothing to compensate).
--
-- 2. A third kind, `burn`, carries the issuer-return half of a
--    redemption: when a `paymentMethod='loop_asset'` deposit pays an
--    order, `markOrderPaid` debits the `user_credits` mirror AND (same
--    txn) enqueues a `kind='burn'` payout that forwards the received
--    LOOP from the deposit/operator account to the asset's issuer —
--    Stellar burns payments to the issuing account natively. Burn rows
--    keep `order_id` (audit trail back to the redemption order), so the
--    one-payout-per-order unique index is split per-kind: a redeemed
--    order can carry its burn row alongside its (later) cashback row.
--
-- 3. The active-intent uniqueness fence keeps its semantics under the
--    new name (`pending_payouts_active_emission_unique`).

ALTER TABLE pending_payouts DROP CONSTRAINT pending_payouts_kind_known;
--> statement-breakpoint
ALTER TABLE pending_payouts DROP CONSTRAINT pending_payouts_kind_shape;
--> statement-breakpoint
UPDATE pending_payouts SET kind = 'emission' WHERE kind = 'withdrawal';
--> statement-breakpoint
ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_known
  CHECK (kind IN ('order_cashback', 'emission', 'burn'));
--> statement-breakpoint
ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_shape
  CHECK (
    (kind = 'order_cashback' AND order_id IS NOT NULL)
    OR (kind = 'emission' AND order_id IS NULL)
    OR (kind = 'burn' AND order_id IS NOT NULL)
  );
--> statement-breakpoint
DROP INDEX pending_payouts_active_withdrawal_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX pending_payouts_active_emission_unique
  ON pending_payouts (user_id, asset_code, asset_issuer, to_address, amount_stroops)
  WHERE kind = 'emission'
    AND state IN ('pending', 'submitted', 'failed')
    AND compensated_at IS NULL;
--> statement-breakpoint
-- Per-kind order uniqueness. The plain index relied on at-most-one row
-- per order; with burn rows that's one *cashback* row per order plus at
-- most one *burn* row per order. `insertPayout`'s ON CONFLICT target
-- moves to `(order_id) WHERE kind = 'order_cashback'` in lockstep.
DROP INDEX pending_payouts_order_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX pending_payouts_order_unique
  ON pending_payouts (order_id)
  WHERE kind = 'order_cashback';
--> statement-breakpoint
CREATE UNIQUE INDEX pending_payouts_burn_order_unique
  ON pending_payouts (order_id)
  WHERE kind = 'burn';
