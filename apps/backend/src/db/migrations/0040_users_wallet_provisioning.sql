-- ADR 030 Phase C — wallet provisioning state machine on users.
--
-- `wallet_provisioning` drives the signup-time + sweeper-driven
-- embedded-wallet flow:
--
--   none           → no provider wallet yet (default; also every
--                    pre-Phase-C row)
--   wallet_created → provider wallet exists (`wallet_id` /
--                    `wallet_address` populated) but the Stellar
--                    account has not been activated yet
--   activated      → operator-sponsored activation landed: account
--                    created with zero XLM + trustlines to every
--                    configured LOOP asset, all reserves sponsored
--                    by the operator
--
-- `wallet_address` is the wallet's Stellar public key (G...) —
-- persisted alongside the Phase-B `wallet_id` so payout targeting
-- (C2) and the balance surface (C4) never round-trip to the
-- provider for an address lookup. Partial unique: two users can
-- never share one on-chain account.
--
-- `wallet_provisioning_attempts` / `_last_attempt_at` are the
-- sweeper's retry bookkeeping — same pattern as the redemption
-- backfill (migration 0034): exponential backoff off last_attempt_at,
-- hard cap pages ops via notifyWalletProvisioningStuck
-- (runbook: docs/runbooks/wallet-provisioning-stuck.md).
ALTER TABLE "users" ADD COLUMN "wallet_address" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_provisioning" text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_provisioning_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_provisioning_last_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_wallet_provisioning_known" CHECK ("wallet_provisioning" IN ('none', 'wallet_created', 'activated'));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_address_unique" ON "users" ("wallet_address") WHERE "wallet_address" IS NOT NULL;
--> statement-breakpoint
-- Sweeper scan support: candidates are exactly the not-yet-activated
-- rows, which the partial index keeps tiny once the fleet is
-- provisioned (activated rows fall out of the index).
CREATE INDEX "users_wallet_provisioning_pending" ON "users" ("created_at") WHERE "wallet_provisioning" <> 'activated';
