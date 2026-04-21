/**
 * Drizzle schema — first pass. Persists the credits-ledger primitives
 * from ADR 009 and the merchant cashback-config surface from ADR 011.
 *
 * Tables here are deliberately minimal for the principal-switch path
 * (ADR 010) which will add order-row columns in the follow-up PR.
 * Nothing else in the backend uses persistence yet; the merchant
 * cache remains in-memory.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  bigint,
  char,
  timestamp,
  numeric,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_ctx_user_id_unique')
      .on(t.ctxUserId)
      .where(sql`${t.ctxUserId} IS NOT NULL`),
    index('users_email').on(t.email),
  ],
);

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
    uniqueIndex('user_credits_user_currency').on(t.userId, t.currency),
    // Negative balance is always a bug (we'd be owing the user
    // more than we've booked). Database-level guard so a bad
    // downstream transaction doesn't silently corrupt the ledger.
    check('user_credits_non_negative', sql`${t.balanceMinor} >= 0`),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_transactions_user_created').on(t.userId, t.createdAt),
    index('credit_transactions_reference').on(t.referenceType, t.referenceId),
    check(
      'credit_transactions_type_known',
      sql`${t.type} IN ('cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment')`,
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
  ],
);

/**
 * Per-merchant cashback split (ADR 011). The three percentages are
 * applied to each order's face value; at order creation we pin the
 * resulting minor-unit amounts onto the order row so a later admin
 * edit doesn't retroactively rewrite completed orders.
 *
 * CHECK ensures wholesale + user + margin ≤ 100. Usually they'll
 * equal the CTX discount %, but we don't hard-enforce equality so
 * we can briefly be "under-captured" if CTX's discount changes
 * between catalog sync and the admin update.
 */
export const merchantCashbackConfigs = pgTable(
  'merchant_cashback_configs',
  {
    merchantId: text('merchant_id').primaryKey(),
    wholesalePct: numeric('wholesale_pct', { precision: 5, scale: 2 }).notNull(),
    userCashbackPct: numeric('user_cashback_pct', { precision: 5, scale: 2 }).notNull(),
    loopMarginPct: numeric('loop_margin_pct', { precision: 5, scale: 2 }).notNull(),
    active: boolean('active').notNull().default(true),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'merchant_cashback_configs_sum',
      sql`${t.wholesalePct} + ${t.userCashbackPct} + ${t.loopMarginPct} <= 100`,
    ),
    check(
      'merchant_cashback_configs_non_negative',
      sql`
        ${t.wholesalePct} >= 0 AND ${t.userCashbackPct} >= 0 AND ${t.loopMarginPct} >= 0
      `,
    ),
  ],
);

/**
 * Audit log for `merchant_cashback_configs`. Written by a trigger
 * installed in the first migration; every update appends the prior
 * values with the changing admin's identity + timestamp, giving us
 * a full history without a version-control-like UX.
 *
 * No FK to `merchantCashbackConfigs` — we want history rows to
 * survive if a config row is ever deleted (which shouldn't happen
 * in normal ops, but the history should outlive it).
 */
export const merchantCashbackConfigHistory = pgTable(
  'merchant_cashback_config_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: text('merchant_id').notNull(),
    wholesalePct: numeric('wholesale_pct', { precision: 5, scale: 2 }).notNull(),
    userCashbackPct: numeric('user_cashback_pct', { precision: 5, scale: 2 }).notNull(),
    loopMarginPct: numeric('loop_margin_pct', { precision: 5, scale: 2 }).notNull(),
    active: boolean('active').notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_cashback_config_history_merchant').on(t.merchantId, t.changedAt)],
);
