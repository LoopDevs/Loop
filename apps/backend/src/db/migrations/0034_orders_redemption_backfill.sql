-- Redemption-backfill bookkeeping (comprehensive audit 2026-06-11 §redemption
-- follow-up). The 2026-05-14 validated e2e purchase fulfilled with
-- redeem_code / redeem_pin / redeem_url all NULL because CTX returned `{}`
-- from GET /gift-cards/:id inside waitForRedemption's budget — and nothing
-- ever re-fetched. The redemption-backfill sweeper
-- (apps/backend/src/orders/redemption-backfill.ts) periodically re-runs
-- fetchRedemption for fulfilled orders that captured a ctx_order_id but no
-- redemption payload. These two columns track per-order attempts so the
-- sweeper backs off exponentially and caps at 10 attempts before paging ops.
ALTER TABLE "orders" ADD COLUMN "redemption_backfill_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "redemption_backfill_last_attempt_at" timestamp with time zone;
--> statement-breakpoint
-- Partial index for the sweeper's poll. The predicate matches the sweeper's
-- WHERE exactly (minus the attempts cap, which is a code-side constant) so
-- the scan stays index-only; the qualifying set is empty in the happy path.
CREATE INDEX "orders_redemption_backfill_pending" ON "orders" ("fulfilled_at") WHERE "state" = 'fulfilled' AND "ctx_order_id" IS NOT NULL AND "redeem_code" IS NULL AND "redeem_pin" IS NULL AND "redeem_url" IS NULL;
