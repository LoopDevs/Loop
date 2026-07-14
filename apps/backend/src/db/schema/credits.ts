/**
 * Drizzle schema — credits domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  char,
  timestamp,
  index,
  check,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Per-user credit balance in a specific regional currency. One row per
 * (user, currency) pair — most users will only ever have one row, but
 * modelling as composite-key means we can support a user moving across
 * regions without a destructive migration.
 *
 * `balance_minor` is an integer in the currency's minor units (pence,
 * cents) to avoid any float drift. Materialised sum of the
 * corresponding `credit_transactions` rows; reconcilable by replay
 * as an audit check.
 */
export const userCredits = pgTable(
  'user_credits',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    // No .default(0n) — drizzle-kit's diff pass can't JSON-serialise
    // a BigInt default. We always insert with an explicit 0 on
    // user-credit upsert, so the column default is academic.
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A2-702: composite primary key replaces the unique index. Semantics
    // are identical (both enforce uniqueness on `(user_id, currency)`),
    // but PKs give logical-replication / CDC tools a stable row identity
    // and pg_stat surfaces them in contexts where unique indexes are
    // opaque. The old `user_credits_user_currency` unique index is
    // dropped by migration 0017 — PK's underlying index covers the same
    // lookups.
    primaryKey({ columns: [t.userId, t.currency], name: 'user_credits_pkey' }),
    // CF-29 / PERF-007: the drift watcher's `sumOutstandingLiability`
    // does `SUM(balance_minor) WHERE currency = X`. The PK leads with
    // `user_id`, so a bare currency predicate can't use it → seq scan
    // once per LOOP asset (3) per drift tick (300s). (Migration 0036.)
    index('user_credits_currency').on(t.currency),
    // Negative balance is always a bug (we'd be owing the user
    // more than we've booked). Database-level guard so a bad
    // downstream transaction doesn't silently corrupt the ledger.
    check('user_credits_non_negative', sql`${t.balanceMinor} >= 0`),
    // A2-903: pin the currency to the three ISO-4217 codes we
    // actually support (ADR 015). Prevents typos / crafted values
    // like 'ZZZ' from landing zombie balance rows that the admin
    // UI can't display. Adding a fourth currency will be a
    // deliberate migration, not silent drift.
    check('user_credits_currency_known', sql`${t.currency} IN ('USD', 'GBP', 'EUR')`),
  ],
);

/**
 * Append-only ledger of credit movements. Every user-visible balance
 * delta has a row here with the business-context reference — order
 * id for cashback / spend / refund, payout id for withdrawals, null
 * for interest and adjustments (the type carries the context).
 *
 * Types are a string-backed enum rather than a native Postgres enum
 * because adding new types (e.g. 'promo') is easier via migration
 * as a CHECK update than an ALTER TYPE dance.
 */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    referenceType: text('reference_type'),
    referenceId: text('reference_id'),
    // A2-908: operator-authored rationale for admin-originated writes
    // (adjustment, refund). Nullable because machine-generated types
    // (cashback / interest / spend) have no operator reason. Prior to
    // this column the reason was kept only in the admin-idempotency
    // snapshot, which a 24h TTL sweep clears — the ledger-replay
    // promise from ADR 017 #4 ("why is reconstructable from the
    // append-only ledger") was false past the TTL.
    reason: text('reason'),
    // Period identifier for `type='interest'` rows — the
    // accrue-interest caller passes a string like `"2026-04-23"` for
    // daily accrual. Combined with the partial unique index below,
    // this makes interest accrual idempotent per period (audit
    // A2-906). Always NULL for non-interest rows (audit A2-610
    // cluster fix).
    periodCursor: text('period_cursor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_transactions_user_created').on(t.userId, t.createdAt),
    // DAT-01-inv1 (migration 0066): backs the commit-time mirror-invariant
    // constraint trigger, which runs `SUM(amount_minor) WHERE user_id = ?
    // AND currency = ?` once per touched (user, currency) on every ledger
    // write. `credit_transactions_user_created` above only prefixes on
    // user_id (so it reads every currency's rows for the user); this
    // `(user_id, currency)` btree serves the check's exact predicate as a
    // bounded range scan over precisely the summed rows.
    index('credit_transactions_user_currency').on(t.userId, t.currency),
    // CF-29 / PERF-001 + PERF-005: the composite `(user_id, created_at)`
    // above can't serve an unfiltered range or a `WHERE type='cashback'`
    // roll-up (leading column is user_id). This `(type, created_at)`
    // index backs both the admin treasury / cashback-realization
    // aggregates and the public cashback-stats endpoint (distinct-user
    // count + per-currency SUM over `type='cashback'`). (Migration 0036.)
    index('credit_transactions_type_created').on(t.type, t.createdAt),
    index('credit_transactions_reference').on(t.referenceType, t.referenceId),
    // A5-8: plain btree on created_at, mirroring PERF-005's
    // `orders_created_at` (migration 0036) for the same reason —
    // neither composite index above has `created_at` as its leading
    // column, so an unfiltered or date-range-only fleet-wide ledger
    // browse (`GET /api/admin/ledger` with no `userId`/`type` filter)
    // would otherwise seq-scan + sort the whole table. This lets the
    // planner serve `ORDER BY created_at DESC LIMIT n` as a bounded
    // backward index scan instead. (Migration 0058.)
    index('credit_transactions_created_at').on(t.createdAt),
    // Partial unique index enforces period-level idempotency for
    // interest accrual. A re-tick with the same `periodCursor`
    // fails at the DB layer rather than silently double-crediting.
    uniqueIndex('credit_transactions_interest_period_unique')
      .on(t.userId, t.currency, t.periodCursor)
      .where(sql`${t.type} = 'interest'`),
    // A2-614 + A2-902 + A2-901: partial unique on
    // (type, reference_type, reference_id) for the at-most-once
    // writer types (cashback, refund, spend, withdrawal). Two CTX
    // webhook retries landing the same cashback payload would
    // otherwise insert two rows; a duplicate refund would
    // double-credit; and a second code path trying to write another
    // withdrawal debit against the same payout row would double-
    // debit. Scope excludes 'adjustment' (idempotency handled by
    // admin_idempotency_keys, ADR 017) and 'interest' (its own
    // partial unique above). 'withdrawal' stays in the scope for the
    // legacy pre-ADR-036 rows (the emission writer no longer debits;
    // the type is reserved for the future fiat-out redemption rail).
    // The admin emission path also has a stronger semantic fence on
    // `pending_payouts` for "same active emission intent" races.
    uniqueIndex('credit_transactions_reference_unique')
      .on(t.type, t.referenceType, t.referenceId)
      .where(
        sql`${t.type} IN ('cashback', 'refund', 'spend', 'withdrawal') AND ${t.referenceType} IS NOT NULL AND ${t.referenceId} IS NOT NULL`,
      ),
    check(
      'credit_transactions_type_known',
      sql`${t.type} IN ('cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment')`,
    ),
    // A2-704: match the `user_credits_currency_known` CHECK so a ledger
    // row can never be written in a currency the aggregate table refuses
    // to hold. The reconciliation query joins on (user_id, currency) —
    // a `JPY` ledger row with no `user_credits` counterpart would surface
    // through A2-900's orphan-drift path forever. Adding a fourth
    // currency is a deliberate migration against both tables.
    check('credit_transactions_currency_known', sql`${t.currency} IN ('USD', 'GBP', 'EUR')`),
    // period_cursor is populated iff type='interest'. Caller supplies
    // the cursor; everything else must leave it NULL.
    check(
      'credit_transactions_period_cursor_interest_only',
      sql`(${t.type} = 'interest') = (${t.periodCursor} IS NOT NULL)`,
    ),
    // Amount sign follows the type — catches bugs where a cashback
    // row is accidentally negative or a withdrawal positive.
    check(
      'credit_transactions_amount_sign',
      sql`
        (${t.type} IN ('cashback', 'interest', 'refund') AND ${t.amountMinor} > 0)
        OR (${t.type} IN ('spend', 'withdrawal') AND ${t.amountMinor} < 0)
        OR (${t.type} = 'adjustment')
      `,
    ),
    // A4-028: pin the ADR-017 reason length contract at the DB
    // layer. App-side handlers validate 2..500, but a direct
    // INSERT (admin shell, future writer) could land an empty or
    // multi-megabyte string. The CHECK is a NULL-tolerant guard:
    // many ledger rows (cashback / spend / interest) leave reason
    // NULL legitimately.
    check(
      'credit_transactions_reason_length',
      sql`${t.reason} IS NULL OR (length(${t.reason}) >= 2 AND length(${t.reason}) <= 500)`,
    ),
  ],
);
