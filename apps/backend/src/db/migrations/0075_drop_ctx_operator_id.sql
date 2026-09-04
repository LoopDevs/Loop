-- 0075_drop_ctx_operator_id.sql  (ADR 051 — retire the operator pool)
--
-- The CTX operator-account pool (ADR 013) is gone: Loop is a
-- first-class operator in the CTX namespace and every server-to-server
-- call authenticates with the single company API key. The per-order
-- `ctx_operator_id` attribution label (only ever populated with the
-- pool-era placeholder) and the two indexes serving the retired
-- per-operator admin drill endpoints go with it.
DROP INDEX IF EXISTS "orders_ctx_operator";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_ctx_operator_created";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "ctx_operator_id";
