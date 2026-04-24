-- A2-901 / ADR-024 §2: generalise `pending_payouts` so the table can
-- carry both (a) order-fulfilment cashback payouts (the existing
-- shape) and (b) withdrawal payouts keyed to a credit_transactions
-- row rather than an order.
--
-- Design notes:
--
-- 1. `order_id` becomes nullable. Order-fulfilment payouts continue
--    to populate it; withdrawal rows leave it NULL.
--
-- 2. The existing `pending_payouts_order_unique` index is LEFT IN
--    PLACE. Postgres UNIQUE indexes default to NULLS DISTINCT, so
--    multiple rows with `order_id IS NULL` coexist without conflict.
--    The idempotency guard on order-fulfilment retries (one payout
--    per order id) survives unchanged — only the non-null rows
--    participate in uniqueness.
--    ADR-024 §2 initially planned a partial unique index; after
--    closer review the plain index gives the same semantics under
--    Postgres's default NULL handling, and keeping it non-partial
--    keeps `onConflictDoNothing({ target: orderId })` working in
--    `credits/pending-payouts.ts::insertPayout` (Drizzle's target
--    syntax emits plain `ON CONFLICT (order_id)` which requires a
--    non-partial matching index).
--
-- 3. A `kind` column discriminates the two row shapes. Default is
--    'order_cashback' so every in-flight row written by the existing
--    cashback fulfilment path gets the correct label on the
--    existing-rows backfill. Withdrawals write 'withdrawal'.
--
-- 4. A per-kind shape CHECK pins the invariant so `kind='withdrawal'
--    AND order_id IS NOT NULL` and `kind='order_cashback' AND
--    order_id IS NULL` are both rejected at the DB layer.

ALTER TABLE pending_payouts
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE pending_payouts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'order_cashback';

ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_known
  CHECK (kind IN ('order_cashback', 'withdrawal'));

ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_shape
  CHECK (
    (kind = 'order_cashback' AND order_id IS NOT NULL)
    OR (kind = 'withdrawal' AND order_id IS NULL)
  );
