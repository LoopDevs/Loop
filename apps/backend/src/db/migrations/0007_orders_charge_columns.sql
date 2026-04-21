-- ADR 015: split the order's "face value" semantics into what the
-- gift card is worth (catalog side, feeds CTX procurement + cashback
-- math) and what the user was charged (home-currency side, feeds the
-- watcher size check + user-facing receipt).
--
-- Migration plan:
--   1. Add charge_minor + charge_currency with defaults so existing
--      rows insert cleanly.
--   2. Backfill legacy rows — true for every pre-ADR-015 order:
--      the user's region == the gift card's region, so
--      charge_* mirrors face_value_* exactly.
--   3. Add CHECK on charge_currency (enum) and extend the
--      non-negative guard to cover charge_minor.

ALTER TABLE "orders"
  ADD COLUMN "charge_minor" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "charge_currency" char(3) NOT NULL DEFAULT 'USD';--> statement-breakpoint

-- Backfill — safe to scan the whole table; we only touch the rows
-- whose charge_* still hold the column defaults (i.e. pre-migration).
UPDATE "orders"
  SET "charge_minor" = "face_value_minor",
      "charge_currency" = "currency"
  WHERE "charge_minor" = 0;--> statement-breakpoint

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_charge_currency_known"
  CHECK ("charge_currency" IN ('USD', 'GBP', 'EUR'));--> statement-breakpoint

-- Extend the existing non-negative guard to cover charge_minor. Drop
-- + recreate since Postgres doesn't have a native ALTER CHECK.
ALTER TABLE "orders"
  DROP CONSTRAINT "orders_minor_amounts_non_negative";--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_minor_amounts_non_negative"
  CHECK (
    "face_value_minor" >= 0
    AND "charge_minor" >= 0
    AND "wholesale_minor" >= 0
    AND "user_cashback_minor" >= 0
    AND "loop_margin_minor" >= 0
  );
