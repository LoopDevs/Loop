-- CF-19 (ADR 035): widen `orders.currency` (catalog-side — what the
-- supplier denominates the gift card in) to admit the extended
-- supplier-currency display markets surfaced under ADR 035:
-- AED / INR / SAR / AUD / MXN, alongside the existing USD / GBP / EUR.
--
-- These five are SEO-promoted display markets (geo-redirect + sitemap)
-- with ≥15 enabled merchants each (AE 203, IN 29, SA 21, AU 17, MX 16)
-- but were previously unbuyable: the loop-native order handler rejected
-- any non-USD/GBP/EUR gift-card currency at 400, and this CHECK was the
-- hard fail-closed fence behind it.
--
-- SCOPE — only `orders.currency` (the *catalog* currency) moves. The
-- cashback / charge currencies stay pinned to USD/GBP/EUR on purpose:
--   - `orders.charge_currency`           — the user is charged in their
--     home currency (USD/GBP/EUR); an extended-market card is FX-pinned
--     to that home currency at order creation, so the extended code only
--     ever lands in `orders.currency`, never in `charge_currency`.
--   - `users.home_currency`,
--     `user_credits.currency`,
--     `credit_transactions.currency`     — these are the *cashback*
--     ledger currencies (1:1 with a LOOP asset). ADR 035 markets are
--     display-only with no cashback band, so no AEDLOOP/INRLOOP/… asset
--     exists and these CHECKs must NOT widen. Mirrors the CAD precedent.
--
-- Loop-side readiness only: a market goes live end-to-end once the
-- external rates service serves a fiat→crypto rate for the currency.
-- Until then the order handler fails gracefully with
-- CURRENCY_NOT_AVAILABLE ("coming soon") — never a wrong charge.
--
-- Idempotent: DROP IF EXISTS keeps a partial-apply rerun safe.
--
-- Pre-flight (not executed — documentation only):
--   SELECT currency, COUNT(*) FROM orders
--    WHERE currency NOT IN
--      ('USD','GBP','EUR','AED','INR','SAR','AUD','MXN')
--    GROUP BY currency;
-- Expected: zero rows. Any unexpected currency needs reconciliation
-- before this migration runs.

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_currency_known;

ALTER TABLE orders
  ADD CONSTRAINT orders_currency_known
  CHECK (currency IN ('USD', 'GBP', 'EUR', 'AED', 'INR', 'SAR', 'AUD', 'MXN'));
