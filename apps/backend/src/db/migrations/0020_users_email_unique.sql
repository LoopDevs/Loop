-- A2-706: `users.email` had only a non-unique btree index. Two
-- concurrent `verify-otp` calls for the same new email could both
-- miss the SELECT in `findOrCreateUserByEmail` and both INSERT,
-- creating duplicate Loop-native user rows. The ADR 013 auth path
-- already acknowledged the race in-comment ("Signup throughput is
-- low enough that the race is not worth a heavier constraint
-- today. A future migration can add a unique index on
-- `LOWER(email) WHERE ctx_user_id IS NULL` when this becomes
-- relevant"). This is that migration — cashback rollout moves
-- Loop-native signup from "optional second path" to "primary",
-- so the race needs a structural fix, not just an acknowledged
-- comment.
--
-- Partial unique scoping (`WHERE ctx_user_id IS NULL`):
--
-- CTX-proxied users have their identity anchored on `ctx_user_id`
-- (which already has a `WHERE ctx_user_id IS NOT NULL` partial
-- unique index from the initial schema). Their `email` is a
-- denormalised copy of whatever CTX carries and can legitimately
-- collide if CTX allows case-variant or multi-account shapes we
-- don't control. Scoping the new uniqueness to `ctx_user_id IS
-- NULL` means Loop-native users get the strict one-row-per-email
-- guarantee while CTX-proxied users keep their existing
-- `ctx_user_id`-anchored uniqueness — the two identity planes don't
-- collide at the constraint layer.
--
-- `LOWER(email)` matches the normalisation `findOrCreateUserByEmail`
-- applies (email.toLowerCase().trim()). Without it, `Alice@x.com`
-- and `alice@x.com` would be considered distinct and the race
-- could still happen across the case boundary.
--
-- This migration will fail if duplicate Loop-native emails already
-- exist in the table — that would be a data-integrity anomaly in
-- pre-launch data and needs manual reconciliation before the
-- unique index can be created. Operators should run the query in
-- the comment below first on any environment with pre-migration
-- data.

-- Pre-flight (not executed — documentation only):
--   SELECT LOWER(email), COUNT(*)
--     FROM users
--    WHERE ctx_user_id IS NULL
--    GROUP BY LOWER(email)
--   HAVING COUNT(*) > 1;
-- Expected: zero rows. If non-empty, dedupe manually before running
-- this migration.

CREATE UNIQUE INDEX users_email_loop_native_unique
  ON users (LOWER(email))
  WHERE ctx_user_id IS NULL;
