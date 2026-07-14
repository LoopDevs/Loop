-- SEC-02-stepup (auth privilege): single-use ledger for admin step-up
-- tokens. ADR 028's step-up token was stateless — the 5-minute `exp`
-- was the ONLY bound, so a single minted token could be replayed for
-- UNLIMITED destructive writes inside the window, and (defaulting to
-- the wildcard `admin-write` scope) for ANY action class. This table
-- records one row per CONSUMED token `jti`; `consumeAdminStepUpToken`
-- (auth/admin-step-up.ts) inserts here with ON CONFLICT (jti) DO
-- NOTHING so the FIRST presentation wins and every replay of the same
-- token is rejected (`already_consumed`) — the same atomic-consume
-- idiom as `refresh_tokens`' tryRevokeIfLive.
--
-- `sub` (admin Loop user id) + `scope` (action class minted for) are
-- carried for forensics. No FK to `users` (the row is an ephemeral
-- single-use marker, not a join key — same reasoning as `otps`).
-- `expires_at` mirrors the token's `exp` so a retention sweep can reap
-- rows once the token can no longer verify.
CREATE TABLE IF NOT EXISTS "admin_step_up_consumptions" (
  "jti" text PRIMARY KEY NOT NULL,
  "sub" text NOT NULL,
  "scope" text NOT NULL,
  "consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "admin_step_up_consumptions_expires"
  ON "admin_step_up_consumptions" ("expires_at");
