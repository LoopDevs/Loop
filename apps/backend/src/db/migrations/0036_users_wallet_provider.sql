-- ADR 030 Phase B — provider-agnostic embedded-wallet substrate.
-- Links a Loop user to their provider-side embedded wallet. Both
-- columns stay NULL until the Phase-C provisioning flow creates a
-- wallet; nothing user-facing reads them yet. `wallet_provider` is
-- CHECK-pinned to the known vendor set ('privy' today — ADR 030's
-- documented dfns fallback would widen the CHECK in a follow-up
-- migration). `wallet_id` is the provider-side wallet identifier
-- (Privy CUID2); the partial unique index guarantees two users can
-- never claim the same provider wallet — the DB-side backstop for
-- the adapter's query-before-create idempotency.
ALTER TABLE "users" ADD COLUMN "wallet_provider" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_wallet_provider_known" CHECK ("wallet_provider" IN ('privy'));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_id_unique" ON "users" ("wallet_id") WHERE "wallet_id" IS NOT NULL;
