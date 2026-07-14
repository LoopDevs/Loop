/**
 * Drizzle schema — users domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  char,
  timestamp,
  integer,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { StaffRole, WalletProvisioningState } from '@loop/shared';

/**
 * Loop users. For the current CTX-anchored identity, populated lazily
 * on the first authenticated admin request we see (the CTX JWT `sub`
 * claim is the external identifier, mirrored here as `ctx_user_id`).
 *
 * Designed forward for the identity takeover (ADR 013): once Loop
 * issues its own OTP and JWTs against a shared CTX operator account,
 * new users will be Loop-native and have `ctx_user_id = NULL`.
 * Existing CTX-mapped rows are preserved and continue to resolve.
 * The uniqueness constraint on `ctx_user_id` is a partial index so
 * multiple NULLs are allowed.
 *
 * `is_admin` is derived from the `ADMIN_CTX_USER_IDS` env allowlist
 * at upsert time; persisting it means authz checks don't scan env
 * on every request.
 *
 * `home_currency` is the fiat the user's account is denominated in
 * (ADR 015). Every order they place is priced in this currency
 * regardless of the gift card's region, and cashback lands in the
 * matching LOOP-branded asset. MVP: support-mediated changes only.
 * Defaults to USD so the column is NOT NULL without requiring an
 * onboarding-picker round-trip on legacy CTX-anchored rows that
 * predate the column.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable — future Loop-native users have no CTX mapping. The
    // partial unique index below only enforces uniqueness where a
    // value is present.
    ctxUserId: text('ctx_user_id'),
    email: text('email').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    // NS-09 — access-token revocation counter (migration 0070). Access
    // tokens are 15-min, signature-only, and carry no per-token DB row,
    // so before this they were NON-REVOCABLE until natural expiry: a
    // logout / password-reset / compromise could not invalidate an
    // already-issued, still-signed access token. This monotonic per-user
    // counter closes that gap — it is embedded as the `tv` claim in every
    // minted access token, compared against this column on EVERY
    // authenticated request (`requireAuth`), and bumped (atomic +1) on
    // logout / sign-out-all / refresh-reuse-detected so all prior access
    // tokens are rejected at once. Refresh tokens keep their own DB-row
    // revocation (`refresh_tokens`); this is the access-token equivalent.
    tokenVersion: integer('token_version').notNull().default(0),
    homeCurrency: char('home_currency', { length: 3 }).notNull().default('USD'),
    // ADR 015 — Stellar address the user wants their cashback paid
    // to (when on-chain payout is available for their home currency).
    // Null = user hasn't linked one; cashback accrues off-chain only.
    // Format: 56-char uppercase base32 starting with 'G' — validated
    // at the API boundary; column is just `text` so ops can null it
    // out with a simple UPDATE if needed.
    stellarAddress: text('stellar_address'),
    // ADR 030 Phase B — embedded-wallet provider linkage. Both NULL
    // until the Phase-C provisioning flow creates a provider wallet
    // for the user. `wallet_provider` is CHECK-pinned to the known
    // vendor set (just 'privy' today; the dfns fallback would be a
    // migration widening the CHECK). `wallet_id` is the provider-side
    // wallet identifier (Privy CUID2); the partial unique index below
    // guarantees two users can never share one provider wallet.
    walletProvider: text('wallet_provider').$type<'privy'>(),
    walletId: text('wallet_id'),
    // ADR 030 Phase C — wallet provisioning state machine (migration
    // 0037). `wallet_address` is the embedded wallet's Stellar public
    // key, persisted at wallet-creation time so payout targeting (C2)
    // and the balance surface (C4) never round-trip to the provider.
    // `wallet_provisioning` walks none → wallet_created → activated;
    // attempts + last_attempt_at are the provisioning sweeper's
    // backoff bookkeeping (same shape as the redemption backfill).
    walletAddress: text('wallet_address'),
    walletProvisioning: text('wallet_provisioning')
      .$type<WalletProvisioningState>()
      .notNull()
      .default('none'),
    walletProvisioningAttempts: integer('wallet_provisioning_attempts').notNull().default(0),
    walletProvisioningLastAttemptAt: timestamp('wallet_provisioning_last_attempt_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_ctx_user_id_unique')
      .on(t.ctxUserId)
      .where(sql`${t.ctxUserId} IS NOT NULL`),
    index('users_email').on(t.email),
    // A2-706: partial unique on LOWER(email) scoped to Loop-native
    // rows (ctx_user_id IS NULL). Prevents the duplicate-INSERT race
    // in findOrCreateUserByEmail. CTX-proxied users keep the
    // ctx_user_id-anchored uniqueness above; their `email` is a
    // denormalised copy and may legitimately collide with a separate
    // Loop-native row (same person, two identity planes).
    uniqueIndex('users_email_loop_native_unique')
      .on(sql`LOWER(${t.email})`)
      .where(sql`${t.ctxUserId} IS NULL`),
    // CF-29 / PERF-006: `user-by-email` resolves ctx-backed users via
    // `LOWER(email) = x`. The functional unique above is partial
    // (`WHERE ctx_user_id IS NULL`) so it can't serve the lookup for
    // CTX-proxied rows. A non-partial functional index covers the
    // equality lookup across both identity planes. (Migration 0036.)
    index('users_email_lower').on(sql`LOWER(${t.email})`),
    // CHECK gates the enum at the DB boundary; the TypeScript union
    // (HOME_CURRENCIES) gates it in-app. Both agree — either layer
    // catching a bad write is a tripwire on the other layer drifting.
    check('users_home_currency_known', sql`${t.homeCurrency} IN ('USD', 'GBP', 'EUR')`),
    // ADR 030 Phase B: same dual-layer pattern as home_currency —
    // the CHECK pins the vendor enum at the DB boundary, the
    // `$type<'privy'>()` narrowing pins it in TypeScript. NULL rows
    // (no wallet provisioned) pass the CHECK by SQL semantics.
    check('users_wallet_provider_known', sql`${t.walletProvider} IN ('privy')`),
    uniqueIndex('users_wallet_id_unique')
      .on(t.walletId)
      .where(sql`${t.walletId} IS NOT NULL`),
    // ADR 030 Phase C (migration 0040): provisioning enum pinned at
    // the DB boundary; one on-chain account per user; partial index
    // keeps the sweeper's candidate scan cheap (activated rows fall
    // out of it).
    check(
      'users_wallet_provisioning_known',
      sql`${t.walletProvisioning} IN ('none', 'wallet_created', 'activated')`,
    ),
    uniqueIndex('users_wallet_address_unique')
      .on(t.walletAddress)
      .where(sql`${t.walletAddress} IS NOT NULL`),
    index('users_wallet_provisioning_pending')
      .on(t.createdAt)
      .where(sql`${t.walletProvisioning} <> 'activated'`),
    // ADR 037 reverse lookup (GET /api/admin/lookup): legacy linked
    // Stellar address → user. Partial — most rows have no address.
    index('users_stellar_address')
      .on(t.stellarAddress)
      .where(sql`${t.stellarAddress} IS NOT NULL`),
  ],
);

/**
 * ADR 030 Phase C — wallet-provisioning state machine values
 * (`users.wallet_provisioning`, migration 0040). The union itself is
 * canonical in `@loop/shared/users-wallet` (`GET /api/me/wallet`
 * returns it on the wire); re-exported here for the many schema-side
 * callers, mirroring the HomeCurrency pattern above. The runtime
 * array is declared here because only the backend needs to iterate
 * the states (sweeper + tests); it is pinned to the same DB CHECK.
 */
export const WALLET_PROVISIONING_STATES = ['none', 'wallet_created', 'activated'] as const;

export type { WalletProvisioningState } from '@loop/shared';

// Home-currency enum + type live in `@loop/shared/loop-asset` alongside
// the LOOP asset codes they map to. Re-exported here for the many
// `db/schema.ts` callers that import both from one module (drizzle
// tables + the currency union).
export { HOME_CURRENCIES, type HomeCurrency } from '@loop/shared';

/**
 * ADR 037 — staff role table (migration 0042). One row per staff
 * member; absence of a row means "not staff" (the public). `role`
 * replaces the binary `users.is_admin` trust model:
 *
 *   admin   → everything (money writes still step-up-gated, ADR 028)
 *   support → read views + the three delivery-unsticking actions
 *
 * `users.is_admin` survives as a deprecated read-compat shim —
 * `requireStaff` falls back to it ('admin') when no row exists, so
 * CTX-allowlist admins (`ADMIN_CTX_USER_IDS` upsert path) keep
 * working until the CTX path retires (ADR 013 Phase C). Role writes
 * mirror the flag (grant admin → true, grant support / revoke →
 * false) so the shim can't resurrect a revoked Loop-native admin.
 *
 * `granted_by_user_id` / `reason` / `granted_at` are the ADR 017
 * actor-attribution trail; the migration-0039 seed rows carry a
 * NULL grantor.
 */
export const staffRoles = pgTable(
  'staff_roles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<StaffRole>().notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
  },
  (t) => [
    // Same dual-layer pattern as home_currency / wallet_provider:
    // CHECK pins the enum at the DB boundary, `$type<StaffRole>()`
    // pins it in TypeScript. Widening to 'finance' / 'operator'
    // later is a CHECK migration, not an ALTER TYPE dance.
    check('staff_roles_role_known', sql`${t.role} IN ('admin', 'support')`),
  ],
);

// Staff-role enum + type live in `@loop/shared/admin-staff` — the
// role is on the wire (`GET /api/admin/staff`, `requireStaff`
// context) so web + backend + openapi compile against one
// definition. Re-exported here for schema-side callers, mirroring
// the HOME_CURRENCIES pattern above.
export { STAFF_ROLES, type StaffRole } from '@loop/shared';
