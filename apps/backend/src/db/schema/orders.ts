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
  integer,
  index,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Loop orders (ADR 052) — a local mirror of a CTX gift card plus
 * Loop's commission log for it.
 *
 * ctx is the payment processor: Loop creates the gift card at CTX
 * acting-as the customer (`operatorReference` = this row's id), the
 * customer pays CTX directly, and CTX fulfils. Loop mirrors CTX's
 * `displayStatus` here (via the giftcard ws topic + the mirror
 * sweep) and records the per-order economics: the user cashback CTX
 * applied as a checkout discount, and the commission Loop expects
 * CTX to accrue for the spread.
 *
 * State machine mirrors CTX `displayStatus`, plus a Loop-local
 * `expired` (CTX never flips an unpaid card when its payment window
 * lapses; the mirror sweep does):
 *   unpaid → paid → fulfilled
 *      └────▶ rejected | refunded | expired
 *
 * `redeem_code` / `redeem_pin` remain the spendable bearer secrets —
 * AES-256-GCM envelope-encrypted at the application layer
 * (orders/redeem-crypto.ts, `enc:v1:` prefix, NS-10 key required in
 * prod). Migration 0035 revokes `loop_readonly`'s SELECT on them.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    merchantId: text('merchant_id').notNull(),

    // Face value printed on the gift card, in the catalog currency.
    faceValueMinor: bigint('face_value_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    // What the customer pays CTX (face value minus the user-cashback
    // discount CTX applies at checkout), in the card's fiat currency.
    // Historical pre-ADR-052 rows carry the old home-currency charge.
    chargeMinor: bigint('charge_minor', { mode: 'bigint' }).notNull().default(0n),
    chargeCurrency: char('charge_currency', { length: 3 }).notNull().default('USD'),

    // Per-order economics (ADR 052). `user_cashback_minor` is the
    // discount CTX gave the customer at checkout (minor units of the
    // card currency); `expected_commission_minor` is the commission
    // Loop expects CTX to accrue for this order (spread × profit
    // share), captured from the operator read-back after create.
    // Null when the read-back hasn't landed yet.
    userCashbackMinor: bigint('user_cashback_minor', { mode: 'bigint' }).notNull(),
    expectedCommissionMinor: bigint('expected_commission_minor', { mode: 'bigint' }),

    // CTX-side identifiers: the gift card id, the payment row backing
    // it (drives the payment screen + expiry), and the chain-qualified
    // crypto currency the customer chose to pay in.
    ctxOrderId: text('ctx_order_id'),
    ctxPaymentId: text('ctx_payment_id'),
    paymentCryptoCurrency: text('payment_crypto_currency'),

    // Redemption payload, populated once CTX fulfils (see header).
    redeemCode: text('redeem_code'),
    redeemPin: text('redeem_pin'),
    redeemUrl: text('redeem_url'),

    // Mirror-sweep bookkeeping (migration 0034 lineage): backoff
    // counter shared by the redemption backfill for fulfilled rows
    // missing their payload.
    redemptionBackfillAttempts: integer('redemption_backfill_attempts').notNull().default(0),
    redemptionBackfillLastAttemptAt: timestamp('redemption_backfill_last_attempt_at', {
      withTimezone: true,
    }),

    state: text('state').notNull().default('unpaid'),
    failureReason: text('failure_reason'),

    // A2-2003: client-supplied `Idempotency-Key` HTTP header at create
    // time; the partial unique index below fences duplicate creates.
    idempotencyKey: text('idempotency_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    index('orders_user_created').on(t.userId, t.createdAt),
    // CF-29 / PERF-005: unfiltered created_at range for the admin
    // activity sparkline + time-series views.
    index('orders_created_at').on(t.createdAt),
    // ADR 052: the mirror sweep polls non-terminal rows (unpaid →
    // expiry check, paid → fulfilment catch-up). Partial: only
    // in-flight rows are hot.
    index('orders_open_mirror')
      .on(t.createdAt)
      .where(sql`${t.state} IN ('unpaid', 'paid')`),
    // A2-709: admin aggregates filter `state='fulfilled' AND
    // fulfilled_at >= since`, most additionally on merchant_id.
    index('orders_fulfilled_merchant_at')
      .on(t.merchantId, t.fulfilledAt)
      .where(sql`${t.state} = 'fulfilled'`),
    index('orders_fulfilled_at')
      .on(t.fulfilledAt)
      .where(sql`${t.state} = 'fulfilled'`),
    // Redemption-backfill sweeper poll (migration 0034): fulfilled rows
    // that captured a ctx_order_id but no redemption payload.
    index('orders_redemption_backfill_pending')
      .on(t.fulfilledAt)
      .where(
        sql`${t.state} = 'fulfilled' AND ${t.ctxOrderId} IS NOT NULL AND ${t.redeemCode} IS NULL AND ${t.redeemPin} IS NULL AND ${t.redeemUrl} IS NULL`,
      ),
    check(
      'orders_state_known',
      sql`${t.state} IN ('unpaid', 'paid', 'fulfilled', 'rejected', 'refunded', 'expired')`,
    ),
    // A2-705 / CF-19: catalog-side currency — the three cashback home
    // currencies plus the extended catalog markets (ADR 035, + CAD
    // under ADR 052). Keep in lock-step with `ORDERABLE_CURRENCIES`
    // in `@loop/shared` and the latest orders_currency migration
    // (currently 0079).
    check(
      'orders_currency_known',
      sql`${t.currency} IN ('USD', 'GBP', 'EUR', 'AED', 'INR', 'SAR', 'AUD', 'MXN', 'CAD')`,
    ),
    check(
      'orders_minor_amounts_non_negative',
      sql`
        ${t.faceValueMinor} >= 0
        AND ${t.chargeMinor} >= 0
        AND ${t.userCashbackMinor} >= 0
        AND (${t.expectedCommissionMinor} IS NULL OR ${t.expectedCommissionMinor} >= 0)
      `,
    ),
    // NS-16: a zero-value order is not a real product.
    check('orders_face_value_positive', sql`${t.faceValueMinor} > 0`),
    // A2-2003: see `idempotencyKey` column comment.
    uniqueIndex('orders_user_idempotency_unique')
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

// Order state enum lives in `@loop/shared` (ADR 019) — the CHECK
// literal above and the UI filter chips on `/admin/orders` read from
// the same tuple. Re-exported here so existing backend imports
// (`from '../db/schema.js'`) keep resolving.
export { ORDER_STATES, type OrderState } from '@loop/shared';
