-- Hardening A4 (docs/hardening-plan-2026-07.md) — durable record of
-- operator→CTX settlement payments (ADR 010 principal switch).
--
-- payCtxOrder forwards user-paid value to CTX from the operator
-- wallet — real money leaving Loop's custody — yet nothing recorded
-- it: idempotency rested entirely on a bounded Horizon memo scan of
-- the shared deposit+operator account (a prior payment scrolling
-- past the window meant a retry would DOUBLE-PAY), and the only
-- durable evidence Loop paid CTX was the chain itself.
--
-- One row per order; tx_hash persists BEFORE the network submit
-- (CF-18 pattern) so recovery uses the authoritative point lookup,
-- not a history scan.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS. Rollback: DROP TABLE
-- ctx_settlements.

CREATE TABLE IF NOT EXISTS ctx_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  destination text NOT NULL,
  memo_text text NOT NULL,
  amount_stroops bigint NOT NULL,
  tx_hash text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctx_settlements_order_id_orders_id_fk
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT ctx_settlements_amount_positive CHECK (amount_stroops > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ctx_settlements_order_unique ON ctx_settlements (order_id);
