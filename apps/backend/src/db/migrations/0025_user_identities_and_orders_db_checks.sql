-- A2-712 + A2-714: defence-in-depth DB CHECKs.
--
-- A2-712 — `user_identities.provider` enum CHECK. The handler-edge
-- zod (SOCIAL_PROVIDERS) gates writes from `/api/auth/social/*`,
-- but a direct INSERT (admin DB shell, future writer that forgets
-- the validator) could land a malformed provider that the
-- resolveOrCreateUserForIdentity path can't dispatch. Pin the set
-- at the column.
--
-- A2-714 — `orders.payment_memo` nullability is correlated with
-- payment_method. On-chain methods (xlm / usdc / loop_asset) all
-- need the memo so the payment watcher can match incoming deposits
-- to the order; credit-funded orders skip the memo entirely (no
-- chain transit). `orders/repo.ts` enforces this in code; the CHECK
-- is the DB-layer guard against a manual INSERT bypassing the repo.

ALTER TABLE user_identities
  ADD CONSTRAINT user_identities_provider_known
    CHECK (provider IN ('google', 'apple'));

ALTER TABLE orders
  ADD CONSTRAINT orders_payment_memo_coherence
    CHECK (payment_method = 'credit' OR payment_memo IS NOT NULL);
