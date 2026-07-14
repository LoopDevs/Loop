-- BK-pctcheck + NS-16: two defence-in-depth CHECK constraints on `orders`.
--
-- BK-pctcheck — the pinned cashback-split percentages
-- (`wholesale_pct` / `user_cashback_pct` / `loop_margin_pct`,
-- numeric(5,2) NOT NULL) carried only the combined
-- `orders_percentages_sum` (sum <= 100) guard; nothing rejected a
-- NEGATIVE pct at the DB. A negative percentage inverts the split math
-- (cashback / margin flow the wrong way). The sibling
-- `merchant_cashback_configs` — the SAME three columns these are
-- snapshotted FROM at order creation (ADR 011) — already carries
-- `merchant_cashback_configs_non_negative`; this mirrors that guard onto
-- the pinned copy on `orders`. Each pct is legitimately 0 (a
-- zero-cashback / zero-margin merchant, the env fallback split, and
-- Tranche-1 mode which zeroes `user_cashback_pct` on the row), so the
-- bound is `>= 0`, NOT `> 0`. Complements `orders_percentages_sum`:
-- together they pin every pct into [0, 100], and neither rejects any
-- legitimate row.
--
-- NS-16 — `orders_minor_amounts_non_negative` guards `face_value_minor`
-- at `>= 0`, which admits a ZERO-value order. `face_value_minor` is the
-- gift-card face value — the value the order IS FOR. Both create paths
-- forbid zero at the edge (loop-native `amountMinor` is positive-only:
-- `z.number().int().positive()` / `/^[1-9]\d*$/`; the CTX-proxy `amount`
-- is `.min(0.01)`), and a $0 gift card is not a real product — no comp /
-- free / test order flow creates one. So `face_value_minor` is tightened
-- to `> 0` at the DB boundary. Deliberately scoped to `face_value_minor`
-- ONLY: `charge_minor` can legitimately reach 0 via the Tranche-1
-- instant-discount path at 100% cashback (orders/repo.ts), and the three
-- split minor columns (`wholesale_minor` / `user_cashback_minor` /
-- `loop_margin_minor`) can each be 0 — those stay `>= 0` in
-- `orders_minor_amounts_non_negative`, untouched here.
--
-- Both constraints are drizzle-representable and also declared in
-- `db/schema/orders.ts`, so schema <-> migration parity holds without an
-- allowlist entry (`check:migration-parity`).
--
-- Idempotent DROP IF EXISTS keeps a partial-apply rerun safe (matches
-- the discipline in 0016 / 0029 / 0030).

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_percentages_non_negative;

ALTER TABLE orders
  ADD CONSTRAINT orders_percentages_non_negative
  CHECK (wholesale_pct >= 0 AND user_cashback_pct >= 0 AND loop_margin_pct >= 0);

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_face_value_positive;

ALTER TABLE orders
  ADD CONSTRAINT orders_face_value_positive
  CHECK (face_value_minor > 0);
