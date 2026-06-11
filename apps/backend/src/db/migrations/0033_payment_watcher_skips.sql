-- Skipped-deposit retry ledger (comprehensive-audit 2026-06-11,
-- CRIT #1/#2).
--
-- The payment watcher advances its Horizon cursor past every record
-- on a page, including payments it could not process that tick
-- (oracle outage during the amount check, A4-110 missing credit
-- row, an unexpected markOrderPaid error). Without this table a
-- skipped payment was never re-scanned: the user's funds sat in the
-- deposit account while the order silently expired.
--
-- Schema choices:
--   * `payment_id` (Horizon operation id) is the primary key — a
--     replayed cursor or retry tick upserts the same row, bumping
--     `attempts` instead of duplicating.
--   * `payment` jsonb snapshots the parsed Horizon record so the
--     retry sweep replays the exact matching/validation logic
--     without a Horizon round-trip.
--   * `order_id` carries no FK — the row is operational telemetry
--     and must survive any order lifecycle (expiry, anonymisation).
--   * `reason` / `status` are CHECK-pinned text enums, matching the
--     repo convention (orders.state, pending_payouts.state).
--   * Index on (status, created_at): the only hot query is "oldest
--     pending rows first" in the sweep.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so a partial-apply
-- rerun is safe. Rolled back via `DROP TABLE payment_watcher_skips`.

CREATE TABLE IF NOT EXISTS payment_watcher_skips (
  payment_id text PRIMARY KEY,
  memo text NOT NULL,
  order_id uuid,
  reason text NOT NULL,
  payment jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_watcher_skips_reason_known CHECK (
    reason IN ('asset_mismatch', 'amount_insufficient', 'missing_credit_row', 'processing_error')
  ),
  CONSTRAINT payment_watcher_skips_status_known CHECK (
    status IN ('pending', 'resolved', 'abandoned')
  )
);

CREATE INDEX IF NOT EXISTS payment_watcher_skips_status_created
  ON payment_watcher_skips (status, created_at);
