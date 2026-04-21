-- ADR 015: pending_payouts — persisted Stellar payout intents built
-- by credits/payout-builder.ts on fulfillment. A separate submit
-- worker signs + submits each `pending` row, transitioning through
-- pending → submitted → confirmed (or failed).
--
-- Writing the intent to a table (rather than submitting inline) gives
-- us: retry-on-transient-Horizon-blip, admin visibility into stuck
-- rows, and an idempotency guard via UNIQUE(order_id) against a
-- re-entry of markOrderFulfilled.
CREATE TABLE "pending_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "asset_code" text NOT NULL,
  "asset_issuer" text NOT NULL,
  "to_address" text NOT NULL,
  "amount_stroops" bigint NOT NULL,
  "memo_text" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "tx_hash" text,
  "last_error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "submitted_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  CONSTRAINT "pending_payouts_state_known"
    CHECK ("state" IN ('pending', 'submitted', 'confirmed', 'failed')),
  CONSTRAINT "pending_payouts_amount_positive"
    CHECK ("amount_stroops" > 0),
  CONSTRAINT "pending_payouts_attempts_non_negative"
    CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "pending_payouts"
  ADD CONSTRAINT "pending_payouts_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_payouts"
  ADD CONSTRAINT "pending_payouts_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_payouts_order_unique" ON "pending_payouts"
  USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pending_payouts_state_created" ON "pending_payouts"
  USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "pending_payouts_user" ON "pending_payouts" USING btree ("user_id");
