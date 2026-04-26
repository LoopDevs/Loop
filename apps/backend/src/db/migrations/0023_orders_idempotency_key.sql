-- A2-2003: idempotency-key support for `POST /api/orders/loop`.
--
-- Without this, a client double-click (or a network retry that races
-- the original request) creates two `orders` rows with two payment
-- memos — and for `paymentMethod='credit'` orders, two debits against
-- `user_credits`. The user sees one order in the UI but is charged
-- twice; reconciliation on the admin side has to chase down the
-- duplicate manually.
--
-- The fix is the standard pattern: client sends an `Idempotency-Key`
-- HTTP header (16–128 chars, mirrors the admin idempotency contract
-- in `apps/backend/src/admin/idempotency.ts`). The handler stamps it
-- on the order row, and a partial UNIQUE index on (user_id,
-- idempotency_key) — partial so the column being NULL for legacy
-- rows + clients that don't send the header doesn't collide — turns
-- the duplicate into a unique-violation that the handler catches and
-- replays the already-created order's response.
--
-- Why scoped to (user_id, key) rather than just key:
--   - keys are client-generated; cross-user collisions are realistic
--     (UUIDv4 is unique enough but the contract doesn't require it);
--   - per-user scope means an attacker who guesses or reuses another
--     user's key can't replay-collide their order;
--   - matches the admin layer's (admin_user_id, key) scope so the
--     mental model is the same.

ALTER TABLE orders ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX orders_user_idempotency_unique
  ON orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
