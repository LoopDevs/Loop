-- ADR 017: admin_idempotency_keys — response-snapshot store for
-- admin write endpoints. Keyed on (admin_user_id, key) — scoped to
-- the auth'd admin so two admins can reuse the same opaque key value
-- without colliding. 24h TTL enforced by a nightly cleanup sweep;
-- the column is indexed on `created_at` so the cleanup predicate
-- stays cheap.
CREATE TABLE "admin_idempotency_keys" (
  "admin_user_id" uuid NOT NULL,
  "key" text NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status" integer NOT NULL,
  "response_body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_idempotency_keys_pk" PRIMARY KEY ("admin_user_id", "key"),
  CONSTRAINT "admin_idempotency_keys_key_length"
    CHECK (char_length("key") BETWEEN 16 AND 128),
  CONSTRAINT "admin_idempotency_keys_status_valid"
    CHECK ("status" >= 100 AND "status" < 600)
);--> statement-breakpoint
ALTER TABLE "admin_idempotency_keys"
  ADD CONSTRAINT "admin_idempotency_keys_admin_user_id_users_id_fk"
  FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_idempotency_keys_created_at" ON "admin_idempotency_keys"
  USING btree ("created_at");
