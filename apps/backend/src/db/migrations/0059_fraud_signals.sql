-- B-3 / ADR 045: Phase-1 fraud/abuse controls — duplicate-account
-- detection storage + the index that makes the funding-source-reuse
-- check a bounded lookup instead of a sequential scan.
--
-- `fraud_signals` is a flag-only surface (never auto-block, ADR 045):
-- one row per (signal_type, user_id, related_user_id) pair, written
-- by `fraud/duplicate-account-signals.ts` after a payment-watcher
-- tick observes the same on-chain funding source paying orders for
-- two distinct users. The unique index means a pair that repeatedly
-- co-occurs writes exactly one row, not one per order (also what lets
-- the write path use ON CONFLICT DO NOTHING to detect "is this a
-- fresh signal?" for the Discord-page decision).
CREATE TABLE IF NOT EXISTS "fraud_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "signal_type" text NOT NULL,
  "user_id" uuid NOT NULL,
  "related_user_id" uuid,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fraud_signals_type_known" CHECK ("signal_type" IN ('shared_funding_source')),
  -- Explicit ON DELETE/UPDATE clauses + drizzle-kit's naming
  -- convention ({table}_{column}_{refTable}_{refColumn}_fk) so this
  -- matches `db/schema/fraud.ts`'s `.references(() => users.id,
  -- { onDelete: 'restrict' })` byte-for-byte under
  -- check:migration-parity (mirrors migration 0041's
  -- interest_mint_snapshots_user_id_users_id_fk precedent).
  CONSTRAINT "fraud_signals_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "fraud_signals_related_user_id_users_id_fk"
    FOREIGN KEY ("related_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "fraud_signals_user_created"
  ON "fraud_signals" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "fraud_signals_related_user"
  ON "fraud_signals" ("related_user_id")
  WHERE "related_user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "fraud_signals_type_user_related_unique"
  ON "fraud_signals" ("signal_type", "user_id", "related_user_id");

-- ADR 045 §1/§2: expression index on the JSONB payment snapshot's
-- `from` field (the paying Horizon operation's source Stellar
-- account, already captured by `markOrderPaid` — see R3-2). Without
-- this, the duplicate-account funding-source-reuse check
-- (`WHERE payment_received_payment->>'from' = $1`) would sequential-
-- scan the whole `orders` table on every paid transition — the exact
-- S4-6/PERF-005 shape this repo has hit before. Partial: only
-- on-chain-funded orders (xlm/usdc/loop_asset) ever set this column;
-- credit orders never touch chain and stay excluded from the index.
CREATE INDEX IF NOT EXISTS "orders_payment_source_account"
  ON "orders" (("payment_received_payment"->>'from'))
  WHERE "payment_received_payment" IS NOT NULL;
