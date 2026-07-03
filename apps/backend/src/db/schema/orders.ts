/**
 * Drizzle schema — orders domain (hardening D2 split).
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
  numeric,
  integer,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

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

    // Face value printed on the gift card, in the **catalog**
    // currency (ADR 015). This is what CTX procures, what the
    // cashback split math keys off, and what the user will eventually
    // redeem — independent of the currency the user was charged in.
    //
    // For launch, most orders have `currency === charge_currency`
    // (the user's home currency); the pair diverges when a user
    // buys a gift card from a non-home region (e.g. GBP user buys
    // a $50 USD Amazon US card — face_value_minor=5000, currency=USD,
    // charge_minor=3900 pence, charge_currency=GBP).
    faceValueMinor: bigint('face_value_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    // What the **user** was charged, in their home currency at the
    // time of order creation (ADR 015). Pinned via a one-shot FX
    // conversion against the gift-card face value + currency, and is
    // the amount the payment watcher size-checks incoming Stellar
    // payments against.
    //
    // Legacy rows (pre-ADR-015) backfill with charge_minor =
    // face_value_minor and charge_currency = currency via the
    // migration's UPDATE — true when the user bought in their own
    // region, which was every order before home-currency landed.
    //
    // A4-030: `.default(0n)` mirrors the migration's
    // `DEFAULT 0` so a future `drizzle-kit generate` doesn't emit a
    // spurious `DROP DEFAULT`. The default is harmless in practice
    // because `.notNull()` on a non-nullable insert never falls
    // through to the default — handlers always supply a value —
    // but the schema/migration parity matters for migration drift.
    chargeMinor: bigint('charge_minor', { mode: 'bigint' }).notNull().default(0n),
    // Same A4-030 treatment as `chargeMinor` above: the 0007 migration
    // declares `DEFAULT 'USD'` (so pre-existing rows backfill on ADD
    // COLUMN); mirror it here so schema.ts ↔ migration parity holds
    // (`check:migration-parity`). Handlers always supply a value.
    chargeCurrency: char('charge_currency', { length: 3 }).notNull().default('USD'),

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

    // Redemption payload (ADR 010). Populated at fulfillment from
    // CTX's GET /gift-cards/:id. Nullable — some merchant types
    // redeem by URL + challenge code (no static code/pin), and
    // others by a code that may or may not carry a PIN.
    //
    // Sensitive: these fields ARE the gift card. CF-25 / X-PRIV-03:
    // `redeem_code` + `redeem_pin` (the spendable bearer secrets) are
    // AES-256-GCM envelope-encrypted at the application layer when
    // `LOOP_REDEEM_ENCRYPTION_KEY` is set (orders/redeem-crypto.ts) —
    // the column stays `text`, holding `enc:v1:<base64url>` ciphertext
    // instead of plaintext. `redeem_url` is the redemption landing
    // page, not the secret, so it stays plaintext. Migration 0035 also
    // revokes `loop_readonly`'s SELECT on the two secret columns. Key
    // unset → plaintext storage (legacy), backward-safe on read. Fly
    // volume at-rest encryption remains the disk-theft backstop.
    redeemCode: text('redeem_code'),
    redeemPin: text('redeem_pin'),
    redeemUrl: text('redeem_url'),

    // Redemption-backfill bookkeeping (migration 0034, comprehensive
    // audit 2026-06-11). `waitForRedemption` can exhaust its budget and
    // the order still fulfills with all three redeem fields NULL; the
    // redemption-backfill sweeper (orders/redemption-backfill.ts)
    // re-runs the CTX detail fetch for such rows. `attempts` drives the
    // exponential-ish backoff and the 10-attempt cap; `last_attempt_at`
    // gates when the next attempt is due.
    redemptionBackfillAttempts: integer('redemption_backfill_attempts').notNull().default(0),
    redemptionBackfillLastAttemptAt: timestamp('redemption_backfill_last_attempt_at', {
      withTimezone: true,
    }),

    // State machine. `check` constraint below enforces the enum.
    state: text('state').notNull().default('pending_payment'),
    failureReason: text('failure_reason'),

    // A2-2003: client-supplied `Idempotency-Key` HTTP header at create
    // time. Optional — legacy rows + clients that don't send the
    // header carry NULL. The partial unique index below catches a
    // duplicate (user_id, key) pair so a double-clicked or retried
    // request can't write a second order row + (for credit-funded
    // orders) a second debit against `user_credits`.
    idempotencyKey: text('idempotency_key'),

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
    // CF-29 / PERF-005: plain btree on created_at. The composite
    // `(user_id, created_at)` above can't serve an unfiltered range
    // (leading column user_id), so `orders-activity` (default dashboard
    // sparkline) and other all-orders time-series views seq-scan the
    // whole table. (Migration 0036.)
    index('orders_created_at').on(t.createdAt),
    // CF-29 / PERF-006: operator-stats / operators-snapshot-csv filter
    // `ctx_operator_id IS NOT NULL AND created_at >= since`. The
    // single-column `orders_ctx_operator` below can't serve the range;
    // this composite covers the operator-scoped time window.
    // (Migration 0036.)
    index('orders_ctx_operator_created').on(t.ctxOperatorId, t.createdAt),
    // CF-29 / PERF-006: users-recycling-activity filters
    // `payment_method='loop_asset' AND created_at >= 90d` with no index
    // on either column. Partial scoped to loop_asset orders.
    // (Migration 0036.)
    index('orders_loop_asset_created')
      .on(t.createdAt)
      .where(sql`${t.paymentMethod} = 'loop_asset'`),
    // CF-29 / PERF-006: stuck-orders polls `state IN ('paid','procuring')`.
    // `procuring` has `orders_procuring_procured_at` but `paid` had no
    // supporting index. Partial covering both in-flight states.
    // (Migration 0036.)
    index('orders_paid_procuring_created')
      .on(t.createdAt)
      .where(sql`${t.state} IN ('paid', 'procuring')`),
    // Used by the payment-watcher job to find rows awaiting their
    // on-chain deposit. Partial index: only pending rows are hot.
    index('orders_pending_payment')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} = 'pending_payment'`),
    // A2-708: `sweepStuckProcurement` polls for `state='procuring'
    // AND procured_at < cutoff`. Without this partial index every
    // sweep tick scans the full orders table; at scale that blocks
    // a connection per tick. Partial index keyed on procured_at,
    // scoped to in-flight procurement only.
    index('orders_procuring_procured_at')
      .on(t.procuredAt)
      .where(sql`${t.state} = 'procuring'`),
    // A2-709: ~15 admin aggregates (merchant-stats, top-earners,
    // flywheel-stats, supplier-spend, payment-method-activity,
    // …) all filter on `state='fulfilled' AND fulfilled_at >= since`,
    // most additionally on `merchant_id`. Two partial indexes:
    //   - per-merchant cut → `(merchant_id, fulfilled_at)`
    //   - fleet cut → `(fulfilled_at)`
    // Both scoped to fulfilled-only so the index is small enough
    // that the per-merchant aggregate stays index-only at scale.
    index('orders_fulfilled_merchant_at')
      .on(t.merchantId, t.fulfilledAt)
      .where(sql`${t.state} = 'fulfilled'`),
    index('orders_fulfilled_at')
      .on(t.fulfilledAt)
      .where(sql`${t.state} = 'fulfilled'`),
    // Ops lookup — "did operator X place this order?" — from the
    // admin pool-health surface (ADR 013).
    index('orders_ctx_operator').on(t.ctxOperatorId),
    // ADR 037 reverse lookup (GET /api/admin/lookup): payment memo →
    // order. Partial — legacy CTX-proxy orders have no memo. Also
    // serves the watcher's findPendingOrderByMemo hot path.
    index('orders_payment_memo')
      .on(t.paymentMemo)
      .where(sql`${t.paymentMemo} IS NOT NULL`),
    // Redemption-backfill sweeper poll (migration 0034): fulfilled rows
    // that captured a ctx_order_id but no redemption payload. Partial
    // index keeps the scan tiny — the qualifying set is empty in the
    // happy path. The attempts cap is filtered code-side so changing
    // the constant doesn't require an index rebuild.
    index('orders_redemption_backfill_pending')
      .on(t.fulfilledAt)
      .where(
        sql`${t.state} = 'fulfilled' AND ${t.ctxOrderId} IS NOT NULL AND ${t.redeemCode} IS NULL AND ${t.redeemPin} IS NULL AND ${t.redeemUrl} IS NULL`,
      ),
    check(
      'orders_state_known',
      sql`${t.state} IN ('pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired')`,
    ),
    check(
      'orders_payment_method_known',
      sql`${t.paymentMethod} IN ('xlm', 'usdc', 'credit', 'loop_asset')`,
    ),
    // A2-705: charge-side currency (what the user is billed in). Stays
    // pinned to the three cashback home currencies — the user is always
    // charged in their home currency (1:1 with a LOOP asset). An
    // extended-market card (ADR 035) is FX-pinned to the home currency
    // at order creation, so the extended code only ever lands in
    // `orders.currency` below, never here.
    check('orders_charge_currency_known', sql`${t.chargeCurrency} IN ('USD', 'GBP', 'EUR')`),
    // A2-705 / CF-19: catalog-side currency (what the supplier
    // denominates the gift card in). Mirror of migration 0037 — admits
    // the three home currencies plus the ADR-035 extended display
    // markets (AED/INR/SAR/AUD/MXN), which are orderable on the XLM rail
    // but have no cashback band. Deliberately WIDER than
    // `orders_charge_currency_known` / `user_credits_currency_known`:
    // those stay USD/GBP/EUR because the cashback ledger has no extended
    // asset. Keep this list in lock-step with `ORDERABLE_CURRENCIES` in
    // `@loop/shared` and migration 0037.
    check(
      'orders_currency_known',
      sql`${t.currency} IN ('USD', 'GBP', 'EUR', 'AED', 'INR', 'SAR', 'AUD', 'MXN')`,
    ),
    check(
      'orders_percentages_sum',
      sql`${t.wholesalePct} + ${t.userCashbackPct} + ${t.loopMarginPct} <= 100`,
    ),
    // Nonneg guards across the minor-unit columns. A negative face
    // value or charge is a bug; so is any split going the wrong way.
    check(
      'orders_minor_amounts_non_negative',
      sql`
        ${t.faceValueMinor} >= 0
        AND ${t.chargeMinor} >= 0
        AND ${t.wholesaleMinor} >= 0
        AND ${t.userCashbackMinor} >= 0
        AND ${t.loopMarginMinor} >= 0
      `,
    ),
    // A2-714: payment_memo nullability is correlated with payment
    // method. On-chain methods (xlm / usdc / loop_asset) all
    // require a memo so the payment watcher can match incoming
    // deposits to the order; credit-funded orders skip the memo
    // entirely (no chain transit). The repo enforces this in code,
    // the CHECK enforces it at the DB layer against a manual
    // INSERT.
    check(
      'orders_payment_memo_coherence',
      sql`${t.paymentMethod} = 'credit' OR ${t.paymentMemo} IS NOT NULL`,
    ),
    // A2-2003: see `idempotencyKey` column comment. Partial unique
    // index because legacy rows + non-idempotent clients persist
    // NULL and would otherwise all collide on a single key.
    uniqueIndex('orders_user_idempotency_unique')
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

// Order state + payment-method enums live in `@loop/shared` (ADR 019)

// — the CHECK literal above and the UI filter chips on `/admin/orders`
// read from the same tuple. Re-exported here so existing backend
// imports (`from '../db/schema.js'`) keep resolving during the
// transition window.
export {
  ORDER_STATES,
  type OrderState,
  ORDER_PAYMENT_METHODS,
  type OrderPaymentMethod,
} from '@loop/shared';
