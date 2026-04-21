CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"merchant_id" text NOT NULL,
	"face_value_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_method" text NOT NULL,
	"payment_memo" text,
	"payment_received_at" timestamp with time zone,
	"wholesale_pct" numeric(5, 2) NOT NULL,
	"user_cashback_pct" numeric(5, 2) NOT NULL,
	"loop_margin_pct" numeric(5, 2) NOT NULL,
	"wholesale_minor" bigint NOT NULL,
	"user_cashback_minor" bigint NOT NULL,
	"loop_margin_minor" bigint NOT NULL,
	"ctx_order_id" text,
	"ctx_operator_id" text,
	"state" text DEFAULT 'pending_payment' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"procured_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "orders_state_known" CHECK ("orders"."state" IN ('pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired')),
	CONSTRAINT "orders_payment_method_known" CHECK ("orders"."payment_method" IN ('xlm', 'usdc', 'credit')),
	CONSTRAINT "orders_percentages_sum" CHECK ("orders"."wholesale_pct" + "orders"."user_cashback_pct" + "orders"."loop_margin_pct" <= 100),
	CONSTRAINT "orders_minor_amounts_non_negative" CHECK (
		"orders"."face_value_minor" >= 0
		AND "orders"."wholesale_minor" >= 0
		AND "orders"."user_cashback_minor" >= 0
		AND "orders"."loop_margin_minor" >= 0
	)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_user_created" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_pending_payment" ON "orders" USING btree ("state","created_at") WHERE "orders"."state" = 'pending_payment';--> statement-breakpoint
CREATE INDEX "orders_ctx_operator" ON "orders" USING btree ("ctx_operator_id");
