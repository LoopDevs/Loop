-- 0072_rail_kill_switches.sql  (NS-04 — runtime rail kill/halt switches)
--
-- Durable, admin-toggleable runtime halt for the four money rails
-- (deposit / payout / vault / refund). One row per rail. `halted`
-- defaults FALSE — the default state is "not halted" (a PROTECTED CLASS;
-- see docs/audit/audit-2026-07/ns-04-kill-switches-design.md §7). A
-- missing row is ALSO treated as "not halted" by enforcement reads
-- (belt-and-suspenders); the seed below keeps the admin list endpoint
-- complete from day one. Enforcement reads this table at each rail's
-- entry point (block-new-only) and FAILS CLOSED on a read error (a rail
-- whose state can't be read is treated as HALTED — the CFG-06 / A4-047
-- precedent). The admin API (halt / resume / list) is the only writer.
--
-- Distinct from the env/secret kill switches in kill-switches.ts: that
-- module names env subsystems flipped via `fly secrets set`; this one
-- names DB-backed rails toggled via an admin API.
--
-- Idempotent CREATE/INSERT so a partial-apply rerun is safe. Rolled back
-- via `DROP TABLE rail_kill_switches`.
CREATE TABLE IF NOT EXISTS "rail_kill_switches" (
  "rail" text PRIMARY KEY NOT NULL,
  "halted" boolean DEFAULT false NOT NULL,
  "reason" text,
  "actor_user_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Only the four known rails may exist.
  CONSTRAINT "rail_kill_switches_rail_known"
    CHECK ("rail" IN ('deposit', 'payout', 'vault', 'refund')),
  -- A halted switch must carry who + why (audit completeness). An open
  -- switch may retain them from the last toggle, or be null at seed.
  CONSTRAINT "rail_kill_switches_halted_has_reason"
    CHECK ("halted" = false OR ("reason" IS NOT NULL AND "actor_user_id" IS NOT NULL))
);
--> statement-breakpoint

-- FK named to match drizzle's auto-derived `<table>_<col>_users_id_fk`
-- so `check:migration-parity` sees identical constraint names on both
-- sides (the 0011 / 0041 precedent). ON DELETE RESTRICT — an admin who
-- toggled a rail can't be hard-deleted out from under the audit trail.
ALTER TABLE "rail_kill_switches"
  ADD CONSTRAINT "rail_kill_switches_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Seed all four rails OPEN so enforcement always finds a row and the
-- default is unambiguously "not halted". Data, not schema — the parity
-- gate introspects catalog only, so these rows don't affect it.
INSERT INTO "rail_kill_switches" ("rail", "halted") VALUES
  ('deposit', false),
  ('payout', false),
  ('vault', false),
  ('refund', false)
ON CONFLICT ("rail") DO NOTHING;
