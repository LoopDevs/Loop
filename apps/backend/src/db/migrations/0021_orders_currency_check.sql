-- A2-705: `orders.currency` (catalog-side — what CTX denominates
-- the gift card in) had no CHECK; any 3-char string would land. A
-- typo or a bad mapping in the catalog-sync layer could pin an
-- order to 'ZZZ' and the reconciliation view would never surface
-- it. Lock to the three Loop-asset currencies for parity with
-- `orders_charge_currency_known`, `user_credits_currency_known`,
-- and `credit_transactions_currency_known`.
--
-- If Loop ever sells gift cards in a fourth currency (e.g. CAD,
-- which CTX may offer), it will land via a deliberate migration
-- that touches every *_currency_known CHECK across the schema so
-- all four tables move together.
--
-- Pre-flight (not executed — documentation only):
--   SELECT currency, COUNT(*) FROM orders
--    WHERE currency NOT IN ('USD', 'GBP', 'EUR')
--    GROUP BY currency;
-- Expected: zero rows. Any unexpected currency needs reconciliation
-- before this migration runs.

ALTER TABLE orders
  ADD CONSTRAINT orders_currency_known
  CHECK (currency IN ('USD', 'GBP', 'EUR'));
