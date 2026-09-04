-- ADR 031 V4 latent-bug fix, surfaced by the ADR 052 test refit: a
-- withdrawal-sourced vault redemption writes its `kind='burn'`
-- conservation audit row with order_id NULL (there is no order), but
-- `pending_payouts_kind_shape` (0041) required burns to carry an
-- order id — the dormant withdrawal path could never settle against
-- a real database. Relax the burn arm to allow both shapes:
-- order-linked burns (historical order_redeem rows) and orderless
-- withdrawal burns. Idempotency is unaffected — the mirror
-- transaction's `credit_transactions` unique reference index rolls
-- back a duplicate settle before its burn insert commits.

ALTER TABLE pending_payouts DROP CONSTRAINT pending_payouts_kind_shape;
--> statement-breakpoint
ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_shape
  CHECK (
    (kind = 'order_cashback' AND order_id IS NOT NULL)
    OR (kind = 'emission' AND order_id IS NULL)
    OR (kind = 'burn')
    OR (kind = 'interest_mint' AND order_id IS NULL)
  );
