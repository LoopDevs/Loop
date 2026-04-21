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
  integer,
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

/**
 * One-time passcodes for Loop-native auth (ADR 013).
 *
 * Stored as SHA-256 of the 6-digit code — the code is only ever in
 * plaintext in the operator-sent email and the user-entered body of
 * `POST /api/auth/verify-otp`. The row is marked `consumed_at` on
 * successful verification so a replay of the same code is rejected.
 *
 * `attempts` is bumped on each bad code; the handler rejects once it
 * hits a small ceiling (5) so online brute force against a specific
 * OTP is not viable. An expired OTP is never re-emitted — the user
 * hits `request-otp` again, which writes a fresh row.
 *
 * No FK to `users` because OTP issuance precedes user creation — the
 * user row is created (or resolved) inside the `verify-otp` handler
 * on first success. Linking by email is sufficient.
 */
export const otps = pgTable(
  'otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Lookup: "does this email have a live, unconsumed OTP with this
    // code hash?" `expires_at` keeps the index covering so the planner
    // can short-circuit.
    index('otps_email_expires').on(t.email, t.expiresAt),
  ],
);

/**
 * Active refresh tokens (ADR 013). One row per live refresh; revoked
 * on use (rotation) or on sign-out / security-revoke.
 *
 * `jti` matches the Loop JWT `jti` claim — stable identifier for the
 * token independent of the signed bytes. Lookup on refresh is O(1)
 * via the PK. `token_hash` stores SHA-256 of the full signed token
 * string as a defence-in-depth check: if an attacker somehow gets
 * the jti but not the full token, they can't pass verification.
 *
 * `revoked_at` is set on successful rotation (to the superseding
 * token's jti via `replaced_by_jti`) or on explicit revocation.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    jti: text('jti').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByJti: text('replaced_by_jti'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user').on(t.userId),
    // Used by a periodic cleanup job that trims fully-expired rows
    // after the refresh horizon; also used to reject a token whose
    // row is missing from the table entirely.
    index('refresh_tokens_expires').on(t.expiresAt),
  ],
);

/**
 * Loop-native orders (ADR 010).
 *
 * Under the principal switch Loop owns the order state machine:
 *   pending_payment → paid → procuring → fulfilled
 *                               └────▶ failed | expired
 *
 * Cashback percentages are **pinned** at order creation from the
 * merchant's current `merchant_cashback_configs` row (ADR 011) so a
 * later admin edit doesn't retroactively rewrite completed orders.
 * We also pin the derived minor-unit amounts (wholesale / user
 * cashback / Loop margin) so the ledger write on fulfillment doesn't
 * have to redo the math against a possibly-different config.
 *
 * `ctx_order_id` + `ctx_operator_id` capture which CTX operator
 * account procured the gift card post-payment, for the operational
 * / audit trail (ADR 013 operator pool).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    merchantId: text('merchant_id').notNull(),

    // Face value the user sees on the gift card. Stored in minor
    // units (pence, cents) as bigint to dodge any float drift.
    faceValueMinor: bigint('face_value_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    // Payment source:
    //   - 'xlm'    → Stellar XLM to a Loop deposit address, `payment_memo` set
    //   - 'usdc'   → USDC (Stellar) to the same address + memo
    //   - 'credit' → debit from the user's Loop credit balance (ADR 009)
    // ACH / Plaid lands later; enum is deliberately narrow for now so a
    // new source is a migration (not a silent string on the wire).
    paymentMethod: text('payment_method').notNull(),
    paymentMemo: text('payment_memo'),
    paymentReceivedAt: timestamp('payment_received_at', { withTimezone: true }),

    // Pinned cashback split (ADR 011 snapshot at creation).
    wholesalePct: numeric('wholesale_pct', { precision: 5, scale: 2 }).notNull(),
    userCashbackPct: numeric('user_cashback_pct', { precision: 5, scale: 2 }).notNull(),
    loopMarginPct: numeric('loop_margin_pct', { precision: 5, scale: 2 }).notNull(),
    wholesaleMinor: bigint('wholesale_minor', { mode: 'bigint' }).notNull(),
    userCashbackMinor: bigint('user_cashback_minor', { mode: 'bigint' }).notNull(),
    loopMarginMinor: bigint('loop_margin_minor', { mode: 'bigint' }).notNull(),

    // CTX-side procurement record. Null until state ≥ procuring.
    ctxOrderId: text('ctx_order_id'),
    ctxOperatorId: text('ctx_operator_id'),

    // State machine. `check` constraint below enforces the enum.
    state: text('state').notNull().default('pending_payment'),
    failureReason: text('failure_reason'),

    // Timestamps corresponding to each transition. Nulls are fine —
    // they're set on the transition, never backfilled.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    procuredAt: timestamp('procured_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    index('orders_user_created').on(t.userId, t.createdAt),
    // Used by the payment-watcher job to find rows awaiting their
    // on-chain deposit. Partial index: only pending rows are hot.
    index('orders_pending_payment')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} = 'pending_payment'`),
    // Ops lookup — "did operator X place this order?" — from the
    // admin pool-health surface (ADR 013).
    index('orders_ctx_operator').on(t.ctxOperatorId),
    check(
      'orders_state_known',
      sql`${t.state} IN ('pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired')`,
    ),
    check('orders_payment_method_known', sql`${t.paymentMethod} IN ('xlm', 'usdc', 'credit')`),
    check(
      'orders_percentages_sum',
      sql`${t.wholesalePct} + ${t.userCashbackPct} + ${t.loopMarginPct} <= 100`,
    ),
    // Nonneg guards across all four minor-unit columns. A negative
    // face value is a bug, and so is any split going the wrong way.
    check(
      'orders_minor_amounts_non_negative',
      sql`
        ${t.faceValueMinor} >= 0
        AND ${t.wholesaleMinor} >= 0
        AND ${t.userCashbackMinor} >= 0
        AND ${t.loopMarginMinor} >= 0
      `,
    ),
  ],
);

/**
 * Exposed state enum — mirrors the `CHECK` above. Importing this
 * everywhere keeps the source of truth (the migration) and the
 * callers' type in sync.
 */
export const ORDER_STATES = [
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_PAYMENT_METHODS = ['xlm', 'usdc', 'credit'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];
