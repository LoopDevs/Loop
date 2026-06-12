-- ADR 037 — staff roles + support dashboard.
--
-- `staff_roles` replaces the binary `users.is_admin` trust model
-- with a role table (one row per staff member):
--
--   admin   → everything (money writes still step-up-gated, ADR 028)
--   support → read views + the three delivery-unsticking actions;
--             404 on money writes / CSV exports / Discord config /
--             role management
--
-- Schema choices (mirroring ADR 037 §1 verbatim):
--   * `user_id` PK + ON DELETE CASCADE — a deleted/anonymised user
--     must not leave a dangling grant (DSR/A4-042).
--   * `role` is a CHECK-pinned text enum, matching the repo
--     convention (orders.state, payment_watcher_skips.status) —
--     'finance' / 'operator' later are a CHECK widen, not an
--     ALTER TYPE dance.
--   * `granted_by_user_id` / `reason` / `granted_at` are the
--     ADR 017 actor-attribution trail. `granted_by_user_id` is
--     nullable (the migration seed has no actor) and carries
--     ON DELETE SET NULL so revoking the grantor's account doesn't
--     cascade away the grantee's row.
--
-- One-shot seed: every existing `is_admin` user gets an 'admin'
-- row. `users.is_admin` stays as a deprecated read-compat shim
-- (requireStaff falls back to it when no staff_roles row exists)
-- until the CTX path retires (ADR 013 Phase C).
--
-- Also ships the two partial indexes backing the ADR 037 reverse
-- lookup (`GET /api/admin/lookup` — index-backed queries only):
-- orders by payment memo + users by legacy stellar address. The
-- wallet_address lookup is already covered by
-- `users_wallet_address_unique` (migration 0037).
--
-- Idempotent: every CREATE uses IF NOT EXISTS so a partial-apply
-- rerun is safe; the seed upserts with ON CONFLICT DO NOTHING.
-- Rolled back via `DROP TABLE staff_roles` + `DROP INDEX
-- orders_payment_memo / users_stellar_address`.

CREATE TABLE IF NOT EXISTS staff_roles (
  user_id uuid PRIMARY KEY,
  role text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid,
  reason text,
  CONSTRAINT staff_roles_role_known CHECK (role IN ('admin', 'support')),
  -- Drizzle-style FK names so check-migration-parity diffs clean
  -- against schema.ts without allowlisting (the 0032 …_fkey lesson).
  CONSTRAINT staff_roles_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT staff_roles_granted_by_user_id_users_id_fk
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO staff_roles (user_id, role, reason)
SELECT id, 'admin', 'seed: users.is_admin (migration 0039, ADR 037)'
FROM users
WHERE is_admin = true
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
-- ADR 037 reverse lookup: payment memo → order. Partial — most
-- legacy-CTX orders have no memo, and the watcher's
-- findPendingOrderByMemo hot path also benefits.
CREATE INDEX IF NOT EXISTS orders_payment_memo
  ON orders (payment_memo) WHERE payment_memo IS NOT NULL;
--> statement-breakpoint
-- ADR 037 reverse lookup: legacy linked Stellar address → user.
CREATE INDEX IF NOT EXISTS users_stellar_address
  ON users (stellar_address) WHERE stellar_address IS NOT NULL;
