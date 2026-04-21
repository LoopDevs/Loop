CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_type_known" CHECK ("credit_transactions"."type" IN ('cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment')),
	CONSTRAINT "credit_transactions_amount_sign" CHECK (
        ("credit_transactions"."type" IN ('cashback', 'interest', 'refund') AND "credit_transactions"."amount_minor" > 0)
        OR ("credit_transactions"."type" IN ('spend', 'withdrawal') AND "credit_transactions"."amount_minor" < 0)
        OR ("credit_transactions"."type" = 'adjustment')
      )
);
--> statement-breakpoint
CREATE TABLE "merchant_cashback_config_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" text NOT NULL,
	"wholesale_pct" numeric(5, 2) NOT NULL,
	"user_cashback_pct" numeric(5, 2) NOT NULL,
	"loop_margin_pct" numeric(5, 2) NOT NULL,
	"active" boolean NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_cashback_configs" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"wholesale_pct" numeric(5, 2) NOT NULL,
	"user_cashback_pct" numeric(5, 2) NOT NULL,
	"loop_margin_pct" numeric(5, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_cashback_configs_sum" CHECK ("merchant_cashback_configs"."wholesale_pct" + "merchant_cashback_configs"."user_cashback_pct" + "merchant_cashback_configs"."loop_margin_pct" <= 100),
	CONSTRAINT "merchant_cashback_configs_non_negative" CHECK (
        "merchant_cashback_configs"."wholesale_pct" >= 0 AND "merchant_cashback_configs"."user_cashback_pct" >= 0 AND "merchant_cashback_configs"."loop_margin_pct" >= 0
      )
);
--> statement-breakpoint
CREATE TABLE "user_credits" (
	"user_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"balance_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credits_non_negative" CHECK ("user_credits"."balance_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ctx_user_id" text,
	"email" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credits" ADD CONSTRAINT "user_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_reference" ON "credit_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "merchant_cashback_config_history_merchant" ON "merchant_cashback_config_history" USING btree ("merchant_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credits_user_currency" ON "user_credits" USING btree ("user_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "users_ctx_user_id_unique" ON "users" USING btree ("ctx_user_id") WHERE "users"."ctx_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_email" ON "users" USING btree ("email");--> statement-breakpoint
-- Audit trigger: every UPDATE on merchant_cashback_configs appends the
-- previous row values to merchant_cashback_config_history. Fires BEFORE
-- UPDATE so `updated_by` / `updated_at` on the new row can be inspected
-- later via the history table without racing the UPDATE.
CREATE FUNCTION record_merchant_cashback_config_history() RETURNS trigger AS $$
BEGIN
  INSERT INTO merchant_cashback_config_history (
    merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct,
    active, changed_by, changed_at
  ) VALUES (
    OLD.merchant_id, OLD.wholesale_pct, OLD.user_cashback_pct, OLD.loop_margin_pct,
    OLD.active, OLD.updated_by, OLD.updated_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER merchant_cashback_configs_audit
  BEFORE UPDATE ON merchant_cashback_configs
  FOR EACH ROW EXECUTE FUNCTION record_merchant_cashback_config_history();