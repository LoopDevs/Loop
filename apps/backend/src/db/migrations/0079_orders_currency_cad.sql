-- ADR 052 follow-up: admit CAD into the `orders.currency` CHECK.
--
-- Migration 0037 (CF-19 / ADR 035) enumerated the currencies the
-- FX-feed-gated order path could price: USD/GBP/EUR + AED/INR/SAR/
-- AUD/MXN. CAD was deliberately excluded — the charge was FX-pinned
-- to the user's home currency, and no CAD rate was served.
--
-- ADR 052 retired that model: CTX is the payment processor, the FX
-- feeds are gone, and the order handler now validates the request
-- currency against the merchant's CTX catalog entry instead of
-- `ORDERABLE_CURRENCIES`. CA is an ADR 034 display country whose
-- merchants CTX serves in CAD, so a CAD order passes the handler and
-- died on this CHECK as a raw 500 — the fence had drifted behind the
-- validation it backs. The charge is likewise recorded in the card's
-- currency now (`charge_currency` carries no enum CHECK), so only
-- this constraint moves.
--
-- The fence stays ENUMERATED by choice (not widened to a shape
-- check): every currency CTX newly serves must be admitted here — and
-- in `EXTENDED_ORDER_CURRENCIES` (@loop/shared) + the drizzle mirror
-- in db/schema/orders.ts, kept in lock-step by
-- db/__tests__/orders-currency-check.test.ts — deliberately, with a
-- migration.
--
-- SCOPE — as in 0037, the cashback/ledger currencies
-- (`users.home_currency`, `user_credits.currency`,
-- `credit_transactions.currency`) stay pinned to USD/GBP/EUR: no
-- CADLOOP asset exists and those CHECKs must NOT widen.
--
-- Idempotent: DROP IF EXISTS keeps a partial-apply rerun safe.
--
-- Pre-flight (not executed — documentation only):
--   SELECT currency, COUNT(*) FROM orders
--    WHERE currency NOT IN
--      ('USD','GBP','EUR','AED','INR','SAR','AUD','MXN','CAD')
--    GROUP BY currency;
-- Expected: zero rows. Any unexpected currency needs reconciliation
-- before this migration runs.

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_currency_known;

ALTER TABLE orders
  ADD CONSTRAINT orders_currency_known
  CHECK (currency IN ('USD', 'GBP', 'EUR', 'AED', 'INR', 'SAR', 'AUD', 'MXN', 'CAD'));
