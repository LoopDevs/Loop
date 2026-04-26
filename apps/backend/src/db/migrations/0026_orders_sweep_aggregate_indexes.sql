-- A2-708 + A2-709: partial indexes for stuck-procurement sweep +
-- admin fulfilled-row aggregates.
--
-- A2-708 — `sweepStuckProcurement` filters on
-- `state='procuring' AND procured_at < cutoff`. Without this
-- partial index every sweep tick scans the full orders table; at
-- scale that blocks a connection per tick. Partial keyed on
-- procured_at, scoped to in-flight procurement only.
--
-- A2-709 — every admin merchant / fleet aggregate (merchant-stats,
-- top-earners, flywheel-stats, supplier-spend, payment-method-
-- activity, ~15 endpoints) filters on
-- `state='fulfilled' AND fulfilled_at >= since`, most additionally
-- on `merchant_id`. Two partial indexes:
--   - per-merchant cut → `(merchant_id, fulfilled_at)`
--   - fleet cut → `(fulfilled_at)`
-- Both scoped to fulfilled-only so the index is small enough that
-- the per-merchant aggregate stays index-only at scale.
--
-- All three indexes use `IF NOT EXISTS` so a re-run on a partially-
-- migrated DB is idempotent (cross-ref `migration-rollback.md`
-- §"Idempotency-violating SQL").

CREATE INDEX IF NOT EXISTS orders_procuring_procured_at
  ON orders (procured_at)
  WHERE state = 'procuring';

CREATE INDEX IF NOT EXISTS orders_fulfilled_merchant_at
  ON orders (merchant_id, fulfilled_at)
  WHERE state = 'fulfilled';

CREATE INDEX IF NOT EXISTS orders_fulfilled_at
  ON orders (fulfilled_at)
  WHERE state = 'fulfilled';
