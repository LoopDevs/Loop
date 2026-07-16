-- 0073_account_holds.sql  (NS-08 — per-account freeze / AML-hold)
--
-- Adds the dual-layer per-account freeze capability designed in
-- docs/audit/audit-2026-07/ns-08-account-freeze-design.md:
--
--   1. `account_holds` — an APPEND-ONLY ledger + audit trail. One row
--      per freeze action; `released_at IS NULL` ⇒ the hold is LIVE. The
--      source of truth (who froze/unfroze, why, reason-code, when). Rows
--      are never mutated except the one-time release stamp.
--
--   2. `users.frozen_at` / `users.frozen_scope` — a DENORMALIZED hot-path
--      MIRROR. Every gated debit reads it once (column-scoped, exactly
--      like `users.token_version` / getUserTokenVersion — migration
--      0070) rather than aggregating the ledger per request. NULL ⇒ not
--      frozen. Kept in sync with the ledger INSIDE the same transaction
--      as every place/release write (AccountFreezeService).
--
-- Scope semantics (ADR-style dual-layer: this CHECK is the DB twin of
-- the `ACCOUNT_HOLD_SCOPES` TS union in fraud/account-freeze.ts). Under
-- the ASH strict-AML tiebreak (2026-07), ANY live hold — 'debits_only'
-- OR 'full' — blocks BOTH money-OUT (spend / redeem / withdraw) AND
-- money-IN (outbound cashback / interest / emission payouts): a flagged
-- account receives NOTHING until cleared. The two-tier enum is retained
-- for the audit record + future finer semantics; enforcement is
-- currently uniform across scopes.
--
-- Idempotent CREATE / ADD COLUMN IF NOT EXISTS so a partial-apply rerun
-- is safe (matches 0016 / 0029 / 0030 / 0068 / 0070 / 0072). Rolled back
-- via `DROP TABLE account_holds` + `ALTER TABLE users DROP COLUMN
-- frozen_at, DROP COLUMN frozen_scope`.
CREATE TABLE IF NOT EXISTS "account_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "reason_code" text NOT NULL,
  -- Operator rationale, ADR-017 contract (2..500), same as
  -- credit_transactions.reason.
  "reason" text NOT NULL,
  "placed_by_user_id" uuid NOT NULL,
  "placed_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- NULL ⇒ the hold is LIVE. Set (with released_by + release_reason) on
  -- release.
  "released_at" timestamp with time zone,
  "released_by_user_id" uuid,
  "release_reason" text,
  CONSTRAINT "account_holds_scope_known"
    CHECK ("account_holds"."scope" IN ('full', 'debits_only')),
  CONSTRAINT "account_holds_reason_code_known"
    CHECK ("account_holds"."reason_code" IN (
      'aml_review', 'sanctions_screening', 'suspected_fraud',
      'account_compromise', 'law_enforcement_request',
      'chargeback_investigation', 'other')),
  CONSTRAINT "account_holds_reason_length"
    CHECK (length("account_holds"."reason") >= 2 AND length("account_holds"."reason") <= 500),
  -- Release fields land together or not at all.
  CONSTRAINT "account_holds_release_shape"
    CHECK (("account_holds"."released_at" IS NULL) = ("account_holds"."released_by_user_id" IS NULL)),
  CONSTRAINT "account_holds_release_reason_length"
    CHECK ("account_holds"."release_reason" IS NULL
           OR (length("account_holds"."release_reason") >= 2 AND length("account_holds"."release_reason") <= 500))
);
--> statement-breakpoint

-- FKs named to match drizzle's auto-derived `<table>_<col>_users_id_fk`
-- so `check:migration-parity` sees identical constraint names on both
-- sides (the 0011 / 0041 / 0072 precedent). ON DELETE RESTRICT on the
-- subject + actor — a user referenced by an (audit-trail) hold cannot be
-- hard-deleted out from under it; ON DELETE SET NULL on the releaser
-- (the release stays in the record even if that admin's row is later
-- removed, mirroring staff_roles.granted_by_user_id).
ALTER TABLE "account_holds"
  ADD CONSTRAINT "account_holds_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_holds"
  ADD CONSTRAINT "account_holds_placed_by_user_id_users_id_fk"
  FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_holds"
  ADD CONSTRAINT "account_holds_released_by_user_id_users_id_fk"
  FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- Admin holds dashboard: live holds newest-first.
CREATE INDEX IF NOT EXISTS "account_holds_live"
  ON "account_holds" ("placed_at" DESC) WHERE "released_at" IS NULL;
--> statement-breakpoint
-- Per-user history (admin user-detail) + the "does this user have a live
-- hold" existence check the mirror-recompute uses.
CREATE INDEX IF NOT EXISTS "account_holds_user"
  ON "account_holds" ("user_id", "placed_at" DESC);
--> statement-breakpoint
-- At most ONE live hold per (user, scope) — a second freeze attempt at
-- the same scope is a no-op, not a duplicate row. Partial unique over
-- live rows only.
CREATE UNIQUE INDEX IF NOT EXISTS "account_holds_one_live_per_user_scope"
  ON "account_holds" ("user_id", "scope") WHERE "released_at" IS NULL;
--> statement-breakpoint

-- Denormalized hot-path mirror. NULL ⇒ not frozen. `frozen_at` is the
-- earliest live hold's placed_at; `frozen_scope` is the effective (most
-- restrictive) scope across live holds ('full' > 'debits_only'), so the
-- gate resolves intent without a join. Recomputed to NULL when the last
-- live hold is released. Read once per gated debit (column-scoped).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "frozen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "frozen_scope" text;
--> statement-breakpoint
-- Enum twin of the TS `AccountHoldScope` union (dual-layer). NULL passes
-- by SQL semantics (a not-frozen row).
ALTER TABLE "users"
  ADD CONSTRAINT "users_frozen_scope_known"
  CHECK ("users"."frozen_scope" IS NULL OR "users"."frozen_scope" IN ('full', 'debits_only'));
--> statement-breakpoint
-- Invariant tripwire: the mirror timestamp is set iff a scope is set.
ALTER TABLE "users"
  ADD CONSTRAINT "users_frozen_mirror_shape"
  CHECK (("users"."frozen_at" IS NULL) = ("users"."frozen_scope" IS NULL));
