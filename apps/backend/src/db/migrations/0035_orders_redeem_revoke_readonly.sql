-- Defence-in-depth for gift-card redeem secrets at rest (CF-25 /
-- X-PRIV-03).
--
-- `orders.redeem_code` / `orders.redeem_pin` are now envelope-encrypted
-- at the application layer (orders/redeem-crypto.ts, AES-256-GCM keyed
-- by LOOP_REDEEM_ENCRYPTION_KEY) — a logical DB read sees ciphertext.
-- This migration adds a second layer: revoke the read-only reporting
-- role's SELECT on the two bearer columns so an analytics/dashboard
-- credential can't even pull the ciphertext.
--
-- The role may not exist in every environment (dev / CI / e2e run with
-- a single owner role and no `loop_readonly`). Guard the REVOKE in a
-- DO block that no-ops when the role is absent — the migration must
-- replay cleanly on a fresh scratch DB (check:migration-parity,
-- flywheel-integration) and on production alike.
--
-- Note: REVOKE applies to column privileges already granted to the
-- role; it's harmless (and a no-op) if the role was never granted
-- column SELECT in the first place. We scope to the two secret columns
-- only — `redeem_url` (the redemption landing page, not the secret)
-- stays readable for support tooling.
--
-- Schema parity: this changes only an ACL grant, not the column shape
-- (both stay `text`, holding ciphertext instead of plaintext). The
-- migration↔schema.ts parity check inspects columns / constraints /
-- triggers, not grants, so schema.ts is intentionally untouched.
--
-- Rollback (manual, if ever needed):
--   GRANT SELECT (redeem_code, redeem_pin) ON orders TO loop_readonly;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'loop_readonly') THEN
    REVOKE SELECT (redeem_code, redeem_pin) ON orders FROM loop_readonly;
  END IF;
END
$$;
