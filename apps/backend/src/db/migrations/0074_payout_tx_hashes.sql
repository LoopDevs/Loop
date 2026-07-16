-- 0074_payout_tx_hashes.sql  (PAYOUT-HASHHISTORY — durable tx-hash anchor)
--
-- Append-only ledger of every Stellar tx hash the payout worker has ever
-- signed for a `pending_payouts` row. `pending_payouts.tx_hash` keeps a
-- SINGLE hash — the durable ANCHOR to the funds that first moved (CF-18:
-- persisted in `onSigned`, BEFORE the network submit). Under deep Horizon
-- ingestion lag the FT-05 expiry guard can clear (a landed tx still reads
-- 404 past its timebound) and the re-submit path would OVERWRITE that
-- anchor with a fresh hash, losing the durable link to the value that
-- actually moved on-chain.
--
-- `recordPayoutTxHash` now REFUSES to overwrite a differing non-null
-- anchor and instead appends every signed hash here, so the anchor is
-- preserved AND the full submit history is queryable for reconciliation /
-- double-pay forensics. Same append-only-ledger-beside-a-hot-path-column
-- shape as `account_holds` (0073) / `credit_transactions`.
--
-- `reason`:
--   'first-submit'     — the initial hash; became `pending_payouts.tx_hash`.
--   'resubmit-refused' — a later DIFFERING hash on a re-submit; the anchor
--                        was preserved and this hash appended here only.
--
-- Idempotent CREATE / IF NOT EXISTS so a partial-apply rerun is safe
-- (matches 0068 / 0070 / 0072 / 0073). Rolled back via
-- `DROP TABLE payout_tx_hashes`.
CREATE TABLE IF NOT EXISTS "payout_tx_hashes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payout_id" uuid NOT NULL,
  "tx_hash" text NOT NULL,
  -- `pending_payouts.attempts` at record time — which attempt signed this hash.
  "attempt" integer NOT NULL,
  "reason" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payout_tx_hashes_reason_known"
    CHECK ("payout_tx_hashes"."reason" IN ('first-submit', 'resubmit-refused')),
  CONSTRAINT "payout_tx_hashes_attempt_non_negative"
    CHECK ("payout_tx_hashes"."attempt" >= 0)
);
--> statement-breakpoint

-- FK named to match drizzle's auto-derived `<table>_<col>_<reftable>_id_fk`
-- so `check:migration-parity` sees identical constraint names on both
-- sides. ON DELETE CASCADE: the hash history is a strict child of the
-- payout — if a payout row were ever hard-deleted, its history goes with
-- it (no orphans). `pending_payouts` rows are never deleted in practice.
ALTER TABLE "payout_tx_hashes"
  ADD CONSTRAINT "payout_tx_hashes_payout_id_pending_payouts_id_fk"
  FOREIGN KEY ("payout_id") REFERENCES "public"."pending_payouts"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- History reads: every hash for a payout, oldest-first.
CREATE INDEX IF NOT EXISTS "payout_tx_hashes_payout_recorded"
  ON "payout_tx_hashes" ("payout_id", "recorded_at");
--> statement-breakpoint
-- A given hash is recorded at most ONCE per payout — a same-hash re-record
-- within one attempt is an `ON CONFLICT DO NOTHING` no-op, not a duplicate
-- row. Each attempt signs a distinct hash (fresh seq + fee), so this never
-- collapses genuinely-different submits.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_tx_hashes_payout_tx_unique"
  ON "payout_tx_hashes" ("payout_id", "tx_hash");
