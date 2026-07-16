/**
 * Drizzle schema — fraud/abuse domain (ADR 045, B-3).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Signal types this table can hold. Deliberately a closed, narrow
 * union — ADR 045 Phase 1 implements exactly one detector
 * (`shared_funding_source`); the CHECK constraint below is the DB-side
 * twin so a hand-written INSERT can't introduce an unrecognised type
 * silently.
 */
export const FRAUD_SIGNAL_TYPES = ['shared_funding_source'] as const;
export type FraudSignalType = (typeof FRAUD_SIGNAL_TYPES)[number];

/**
 * ADR 045 §2 — duplicate-account detection storage. Flag-only, never
 * auto-block: a row here is a signal for ops review (queryable
 * directly + a Discord page on first occurrence via
 * `notifyDuplicateAccountSignal`), not an action taken against either
 * user's account.
 *
 * One row per (signal_type, user_id, related_user_id) pair — the
 * unique index means a pair that repeatedly re-triggers the same
 * detector (e.g. the same two accounts funding from the same wallet
 * every week) writes exactly once, and lets the write path use
 * `ON CONFLICT DO NOTHING` to tell "fresh signal" (page Discord) from
 * "already known" (stay quiet) without a separate read.
 *
 * `related_user_id` is nullable for future pairwise-optional signal
 * types (e.g. a rapid-signup-from-one-IP detector would have no
 * natural "other user" — it's a count against an IP, not a pair).
 * Postgres unique indexes treat NULL as distinct-from-every-other-NULL,
 * so a NULL `related_user_id` never collides with another NULL row —
 * uniqueness for such signal types would need a different shape
 * (a separate table or a NULLS NOT DISTINCT index) when one is added;
 * not needed for the single detector implemented here, which always
 * sets `related_user_id`.
 */
export const fraudSignals = pgTable(
  'fraud_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalType: text('signal_type').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    relatedUserId: uuid('related_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Detector-specific evidence, e.g. for `shared_funding_source`:
     * `{ sourceAccount, orderId, relatedOrderId }`. Not schema-typed
     * further — ops reads this via direct DB query in Phase 1 (ADR
     * 044 deliberately defers an admin list endpoint).
     */
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fraud_signals_user_created').on(t.userId, t.createdAt),
    index('fraud_signals_related_user')
      .on(t.relatedUserId)
      .where(sql`${t.relatedUserId} IS NOT NULL`),
    uniqueIndex('fraud_signals_type_user_related_unique').on(
      t.signalType,
      t.userId,
      t.relatedUserId,
    ),
    check('fraud_signals_type_known', sql`${t.signalType} IN ('shared_funding_source')`),
  ],
);

/**
 * NS-08 — per-account freeze / AML-hold ledger (migration 0073).
 *
 * APPEND-ONLY audit trail + source of truth for account freezes. One
 * row per freeze action; `releasedAt IS NULL` ⇒ the hold is LIVE. A user
 * is frozen iff they have ≥1 live hold. Rows are never mutated except
 * the one-time release stamp (`released_at` / `released_by_user_id` /
 * `release_reason`), landing together via the release-shape CHECK.
 *
 * Dual-layer with the hot-path `users.frozen_at` / `users.frozen_scope`
 * MIRROR (the per-debit read, kept in sync inside the same transaction
 * as every place/release write — see `fraud/account-freeze-service.ts`),
 * exactly like `credit_transactions` (ledger) + `user_credits`
 * (materialized balance), and `staff_roles` + `users.is_admin`.
 *
 * The `scope` / `reason_code` CHECKs are the DB twin of the
 * `ACCOUNT_HOLD_SCOPES` / `ACCOUNT_HOLD_REASON_CODES` TS unions in
 * `fraud/account-freeze.ts` — literal here (like `staff_roles_role_known`)
 * so widening the set is a CHECK migration, not an `ALTER TYPE` dance.
 */
export const accountHolds = pgTable(
  'account_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scope: text('scope').notNull(),
    reasonCode: text('reason_code').notNull(),
    /** Operator rationale (ADR-017 contract, 2..500 — same as credit_transactions.reason). */
    reason: text('reason').notNull(),
    placedByUserId: uuid('placed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL while the hold is live; set on release. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedByUserId: uuid('released_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    // Admin holds dashboard: live holds newest-first. `.desc().nullsFirst()`
    // mirrors the migration's `placed_at DESC` exactly (Postgres DESC
    // defaults to NULLS FIRST; drizzle's bare `.desc()` would emit NULLS
    // LAST — the reconciliation.ts / vaults.ts precedent).
    index('account_holds_live')
      .on(t.placedAt.desc().nullsFirst())
      .where(sql`${t.releasedAt} IS NULL`),
    // Per-user history (admin user-detail) + the mirror-recompute's
    // "live holds for this user" scan.
    index('account_holds_user').on(t.userId, t.placedAt.desc().nullsFirst()),
    // At most ONE live hold per (user, scope): a repeat freeze at the
    // same scope is a no-op, not a duplicate row. Partial unique over
    // live rows only.
    uniqueIndex('account_holds_one_live_per_user_scope')
      .on(t.userId, t.scope)
      .where(sql`${t.releasedAt} IS NULL`),
    check('account_holds_scope_known', sql`${t.scope} IN ('full', 'debits_only')`),
    check(
      'account_holds_reason_code_known',
      sql`${t.reasonCode} IN ('aml_review', 'sanctions_screening', 'suspected_fraud', 'account_compromise', 'law_enforcement_request', 'chargeback_investigation', 'other')`,
    ),
    check(
      'account_holds_reason_length',
      sql`length(${t.reason}) >= 2 AND length(${t.reason}) <= 500`,
    ),
    // Release fields land together or not at all.
    check(
      'account_holds_release_shape',
      sql`(${t.releasedAt} IS NULL) = (${t.releasedByUserId} IS NULL)`,
    ),
    check(
      'account_holds_release_reason_length',
      sql`${t.releaseReason} IS NULL OR (length(${t.releaseReason}) >= 2 AND length(${t.releaseReason}) <= 500)`,
    ),
  ],
);
