-- ADR 031 / ADR 036 Phase D — nightly on-chain interest mints.
--
-- 1. A fourth `pending_payouts.kind`, `interest_mint`: a payment FROM
--    the asset's issuer account (a native Stellar mint) to the user's
--    activated embedded wallet, enqueued by the nightly interest-mint
--    worker in the SAME transaction as the `credit_transactions
--    type='interest'` mirror credit. The payout worker signs these
--    rows with the per-asset issuer keypair
--    (`LOOP_STELLAR_<ASSET>_ISSUER_SECRET`) instead of the operator
--    key. Shape: user-addressed, no source order (like 'emission').
--    Idempotency: the same-txn period-cursor partial unique index on
--    credit_transactions is the money-level fence; no per-kind
--    pending_payouts index is needed.
--
-- 2. `interest_mint_snapshots` — the per-(user, asset, UTC-day) audit
--    record of the Horizon balance each night's mint was computed
--    from, plus the sub-minor carry accumulator:
--
--      accrual = floor(balance × apyBps / (10_000 × 365))   [stroops]
--      payable = carry_before + accrual
--      minted_minor = payable / 100_000
--      carry_after  = payable % 100_000
--
--    The mirror (`user_credits`) is integer minor units while Stellar
--    has 7 decimals; minting the raw 7-decimal accrual would diverge
--    the asset-drift equation monotonically. Both halves therefore
--    move by exactly `minted_minor` (× 1e5 stroops on-chain) and the
--    fraction carries forward here until it crosses a whole minor
--    unit. The unique index doubles as the per-night idempotency
--    fence (the snapshot insert shares the txn with the ledger rows).

ALTER TABLE pending_payouts DROP CONSTRAINT pending_payouts_kind_known;
--> statement-breakpoint
ALTER TABLE pending_payouts DROP CONSTRAINT pending_payouts_kind_shape;
--> statement-breakpoint
ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_known
  CHECK (kind IN ('order_cashback', 'emission', 'burn', 'interest_mint'));
--> statement-breakpoint
ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_kind_shape
  CHECK (
    (kind = 'order_cashback' AND order_id IS NOT NULL)
    OR (kind = 'emission' AND order_id IS NULL)
    OR (kind = 'burn' AND order_id IS NOT NULL)
    OR (kind = 'interest_mint' AND order_id IS NULL)
  );
--> statement-breakpoint
CREATE TABLE "interest_mint_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "asset_code" text NOT NULL,
  "asset_issuer" text NOT NULL,
  "currency" char(3) NOT NULL,
  "period_cursor" text NOT NULL,
  "balance_stroops" bigint NOT NULL,
  "accrual_stroops" bigint NOT NULL,
  "carry_before_stroops" bigint NOT NULL,
  "carry_after_stroops" bigint NOT NULL,
  "minted_minor" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interest_mint_snapshots_asset_code_known"
    CHECK ("asset_code" IN ('USDLOOP', 'GBPLOOP', 'EURLOOP')),
  CONSTRAINT "interest_mint_snapshots_issuer_format"
    CHECK ("asset_issuer" ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT "interest_mint_snapshots_currency_known"
    CHECK ("currency" IN ('USD', 'GBP', 'EUR')),
  CONSTRAINT "interest_mint_snapshots_non_negative"
    CHECK (
      "balance_stroops" >= 0
      AND "accrual_stroops" >= 0
      AND "carry_before_stroops" >= 0
      AND "minted_minor" >= 0
    ),
  CONSTRAINT "interest_mint_snapshots_carry_bounded"
    CHECK ("carry_after_stroops" >= 0 AND "carry_after_stroops" < 100000),
  CONSTRAINT "interest_mint_snapshots_conservation"
    CHECK ("carry_before_stroops" + "accrual_stroops" = "minted_minor" * 100000 + "carry_after_stroops")
);
--> statement-breakpoint
ALTER TABLE "interest_mint_snapshots"
  ADD CONSTRAINT "interest_mint_snapshots_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "interest_mint_snapshots_user_asset_period_unique"
  ON "interest_mint_snapshots" ("user_id", "asset_code", "period_cursor");
