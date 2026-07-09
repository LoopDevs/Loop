/**
 * Admin refund writer (A2-901).
 *
 * `type='refund'` was declared in the schema CHECK + shared type
 * surface but had no production writer — admins could not issue a
 * refund without direct DB access. This module adds the primitive.
 *
 * Semantics:
 *   - Amount is ALWAYS positive (the CHECK on credit_transactions
 *     rejects refund with amount <= 0). A debit is an adjustment,
 *     not a refund.
 *   - `referenceType='order', referenceId=<orderId>` — every refund
 *     is bound to the order whose spend it reverses. Scoped by the
 *     partial unique index landed in migration 0013, so two
 *     duplicate refund rows for the same order fail at the DB layer.
 *   - Actor is the admin user (pinned separately in the idempotency
 *     snapshot + Discord audit, not on the credit_transactions row).
 *
 * Intentionally does NOT change the order's state machine. A refund
 * is a ledger-side correction; whether the order is also flipped
 * back to a different state (cancelled, refunded) is a separate
 * support-mediated action.
 */
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders, paymentWatcherSkips, userCredits } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import { env } from '../env.js';
import { adjustmentCapLockKey, DailyAdjustmentLimitError } from './adjustments.js';
import {
  refundDeposit,
  type RefundResult as DepositRefundResult,
} from '../payments/deposit-refund.js';
import { HorizonPaymentSchema, type HorizonPayment } from '../payments/horizon.js';

/**
 * CF-06: advisory-lock scope for the refund daily-cap bucket. Refund
 * rows carry `referenceType='order'` (the refunded order, not the
 * acting admin), so — like the fleet-wide payout-compensation cap
 * (A4-020) — there is no per-admin attribution to key on. The cap is
 * therefore fleet-wide per currency per UTC day: the sum of all
 * `type='refund'` magnitudes plus the new attempt must stay under
 * `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`. This closes the gap where the
 * adjustment cap query (filtered on `type='adjustment'`) was blind to
 * refunds, leaving total per-day refund volume unbounded by count of
 * distinct order ids.
 */
const REFUND_CAP_LOCK_SCOPE = 'refund';

export class RefundAlreadyIssuedError extends Error {
  constructor(public readonly orderId: string) {
    super(`A refund has already been issued for order ${orderId}`);
    this.name = 'RefundAlreadyIssuedError';
  }
}

/**
 * CF-06: the refund references an order that doesn't exist, belongs to
 * a different user than the refund target, was charged in a different
 * currency, or whose charge amount the refund would exceed. The
 * handler maps this to a 400/404/409 at the API edge. Carries a
 * machine-readable `reason` so the handler can pick the right status.
 */
export class RefundOrderInvalidError extends Error {
  constructor(
    public readonly reason:
      | 'order_not_found'
      | 'order_user_mismatch'
      | 'currency_mismatch'
      | 'exceeds_charge',
    message: string,
  ) {
    super(message);
    this.name = 'RefundOrderInvalidError';
  }
}

export interface RefundResult {
  id: string;
  userId: string;
  currency: string;
  amountMinor: bigint;
  orderId: string;
  /** Balance AFTER the refund is credited. */
  newBalanceMinor: bigint;
  /** Balance BEFORE the refund (ledger audit trail). */
  priorBalanceMinor: bigint;
  createdAt: Date;
}

export interface OnChainOrderAutoRefundResult {
  kind: 'onchain_refund';
  orderId: string;
  paymentId: string;
  refund: Extract<DepositRefundResult, { kind: 'refunded' | 'already_refunded' }>;
}

export type OrderAutoRefundResult = RefundResult | OnChainOrderAutoRefundResult;

/**
 * CF-20: synthetic actor id stamped on the `reason` of an automatic
 * (non-admin) order refund. The `credit_transactions` row does not
 * carry an actor column — `applyAdminRefund` pins the admin actor only
 * in the API-boundary idempotency snapshot + Discord audit — so the
 * only durable signal that a refund was system-issued vs operator-
 * issued is the reason prefix. Keep it greppable.
 */
export const AUTO_REFUND_SYSTEM_ACTOR = 'system:auto-refund';

/**
 * CF-20 (x-flows F1-1, v-orders P2-02): automatic order refund issued
 * by the procurement worker when an order fails AFTER Loop has already
 * paid CTX (operator XLM/USDC spent) and the user has already paid
 * Loop. Without this the user is left debited with no gift card and
 * `applyAdminRefund` (admin-only) is the sole recovery, which needs a
 * human to notice the silent `log.error`.
 *
 * Reuses the same validated, idempotent transaction as the admin
 * refund — the partial unique index on
 * `(type='refund', reference_type='order', reference_id)` (migration
 * 0013) makes a second call for the same order a no-op
 * (`RefundAlreadyIssuedError`). The amount is derived from the order's
 * own `chargeMinor` / `chargeCurrency` so the worker can't over-refund
 * or refund the wrong currency: the under-the-row-lock order read
 * inside `applyAdminRefund` is the authority.
 *
 * Returns the `RefundResult` on success. Surfaces
 * `RefundAlreadyIssuedError` (already refunded — caller treats as a
 * safe no-op) and `RefundOrderInvalidError` (the order doesn't exist /
 * mismatches — caller logs; should not happen for a real failed order)
 * to the caller; both are non-fatal at the worker level.
 */
export async function applyOrderAutoRefund(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  orderId: string;
  paymentMethod?: 'xlm' | 'usdc' | 'credit' | 'loop_asset' | string;
  paymentMemo?: string | null;
  paymentReceivedHorizonId?: string | null;
  paymentReceivedPayment?: unknown | null;
  /** Free-text suffix appended after the system-actor prefix. */
  reason: string;
}): Promise<OrderAutoRefundResult> {
  if (args.paymentMethod === 'xlm' || args.paymentMethod === 'usdc') {
    return applyOnChainOrderAutoRefund(args);
  }

  if (args.paymentMethod === 'loop_asset') {
    throw new Error(
      'loop_asset order auto-refund requires coordinated mirror re-credit + on-chain re-mint; manual money-review refund required',
    );
  }

  return applyAdminRefund({
    userId: args.userId,
    currency: args.currency,
    amountMinor: args.amountMinor,
    orderId: args.orderId,
    // No human actor — the worker is the actor. The order-row lock +
    // amount/currency/ownership fences inside applyAdminRefund still
    // apply, so this is exactly as safe as an operator-issued refund.
    adminUserId: AUTO_REFUND_SYSTEM_ACTOR,
    reason: `${AUTO_REFUND_SYSTEM_ACTOR}: ${args.reason}`,
  });
}

async function applyOnChainOrderAutoRefund(args: {
  orderId: string;
  paymentMemo?: string | null;
  paymentReceivedHorizonId?: string | null;
  paymentReceivedPayment?: unknown | null;
  reason: string;
}): Promise<OnChainOrderAutoRefundResult> {
  // DELIBERATE fail-closed for the migration-transition cohort (money
  // review 2026-07-08): orders paid BEFORE migrations 0050/0051 carry
  // no payment snapshot, so their failed-order refund cannot go
  // on-chain. They land in the caller's generic catch → refunded=false
  // → ops page → manual `applyAdminRefund` (which INV-8-excludes a
  // later on-chain double). The alternative — silently falling back to
  // a mirror credit — is the exact wrong-asset drift R3-2 exists to
  // stop. Bounded population: only orders in flight at deploy time.
  if (args.paymentReceivedHorizonId === null || args.paymentReceivedHorizonId === undefined) {
    throw new Error(
      'on-chain auto-refund cannot run without payment_received_horizon_id (pre-0050 order — refund manually via applyAdminRefund)',
    );
  }
  if (args.paymentReceivedPayment === null || args.paymentReceivedPayment === undefined) {
    throw new Error(
      'on-chain auto-refund cannot run without payment_received_payment (pre-0051 order — refund manually via applyAdminRefund)',
    );
  }

  const parsed = HorizonPaymentSchema.safeParse(args.paymentReceivedPayment);
  if (!parsed.success) {
    throw new Error('on-chain auto-refund payment snapshot failed schema validation');
  }
  const payment = parsed.data;
  if (payment.id !== args.paymentReceivedHorizonId) {
    throw new Error('on-chain auto-refund payment snapshot id does not match order identity');
  }

  // INV-8 cross-check (money review 2026-07-08): the on-chain branch
  // does not write a `credit_transactions` refund row, so migration
  // 0013's one-refund-per-order partial unique index cannot see it.
  // Re-establish the exclusion here: under the SAME order-row lock
  // `applyAdminRefund` takes, refuse to send funds on-chain when a
  // mirror-credit refund already exists for this order, and record the
  // refundable-deposit skip row inside the same transaction so the two
  // refund exits serialise on the order row — whichever commits first
  // wins and the loser converges to a no-op / typed error. The third
  // writer (`refundDeposit`, reachable directly via the A6 admin
  // endpoint) carries the same guard inside its claim transaction.
  await db.transaction(async (tx) => {
    const [orderRow] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, args.orderId))
      .for('update');
    if (orderRow === undefined) {
      throw new RefundOrderInvalidError('order_not_found', `Order ${args.orderId} does not exist`);
    }
    const [creditRefund] = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.type, 'refund'),
          eq(creditTransactions.referenceType, 'order'),
          eq(creditTransactions.referenceId, args.orderId),
        ),
      );
    if (creditRefund !== undefined) {
      throw new RefundAlreadyIssuedError(args.orderId);
    }
    await recordFailedOrderRefundableDeposit(tx, {
      orderId: args.orderId,
      memo: args.paymentMemo ?? payment.transaction?.memo ?? '',
      payment,
      detail: `${AUTO_REFUND_SYSTEM_ACTOR}: ${args.reason}`,
    });
  });

  const refund = await refundDeposit(payment.id);
  if (refund.kind !== 'refunded' && refund.kind !== 'already_refunded') {
    throw new Error(`on-chain auto-refund did not complete: ${refund.kind}`);
  }
  return {
    kind: 'onchain_refund',
    orderId: args.orderId,
    paymentId: payment.id,
    refund,
  };
}

async function recordFailedOrderRefundableDeposit(
  tx: Pick<typeof db, 'insert'>,
  args: {
    orderId: string;
    memo: string;
    payment: HorizonPayment;
    detail: string;
  },
): Promise<void> {
  await tx
    .insert(paymentWatcherSkips)
    .values({
      paymentId: args.payment.id,
      memo: args.memo,
      orderId: args.orderId,
      reason: 'order_gone',
      payment: args.payment,
      status: 'abandoned',
      lastError: args.detail.slice(0, 500),
    })
    .onConflictDoUpdate({
      target: paymentWatcherSkips.paymentId,
      set: {
        memo: args.memo,
        orderId: args.orderId,
        reason: 'order_gone',
        payment: args.payment,
        status: 'abandoned',
        lastError: args.detail.slice(0, 500),
        updatedAt: sql`NOW()`,
      },
      setWhere: sql`${paymentWatcherSkips.status} IN ('pending', 'resolved', 'abandoned')`,
    });
}

export async function applyAdminRefund(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  orderId: string;
  adminUserId: string;
  /**
   * A2-908: operator-authored reason, persisted on the ledger row so
   * the "why" survives past the 24h admin-idempotency TTL sweep.
   * Optional because older call sites may not pass one; the admin
   * handler enforces presence at the API boundary.
   */
  reason?: string;
}): Promise<RefundResult> {
  if (args.amountMinor <= 0n) {
    // Schema CHECK already enforces this but we fail fast with a
    // typed error rather than surfacing a pg CHECK violation.
    throw new Error('Refund amount must be positive');
  }

  try {
    return await db.transaction(async (tx) => {
      // CF-06: validate the bound order before crediting anything.
      // Without this an admin (or a captured bearer) could mint a
      // refund credit to any user against a fabricated UUID, against
      // an order that belongs to a *different* user (IDOR), or for
      // more than the order ever cost (over-refund). Lock the order
      // row FOR UPDATE so the charge amount can't shift under us.
      const [order] = await tx
        .select({
          orderUserId: orders.userId,
          chargeMinor: orders.chargeMinor,
          chargeCurrency: orders.chargeCurrency,
          paymentReceivedHorizonId: orders.paymentReceivedHorizonId,
        })
        .from(orders)
        .where(eq(orders.id, args.orderId))
        .for('update');
      if (order === undefined) {
        throw new RefundOrderInvalidError(
          'order_not_found',
          `Order ${args.orderId} does not exist`,
        );
      }
      if (order.orderUserId !== args.userId) {
        throw new RefundOrderInvalidError(
          'order_user_mismatch',
          `Order ${args.orderId} belongs to a different user`,
        );
      }
      // The refund credits the user's home-currency balance; that must
      // be the currency the order charged them in, otherwise the
      // "reverses the spend of this order" invariant (ADR-017/009)
      // doesn't hold and the amount bound below would compare across
      // currencies.
      if (order.chargeCurrency !== args.currency) {
        throw new RefundOrderInvalidError(
          'currency_mismatch',
          `Refund currency ${args.currency} does not match order charge currency ${order.chargeCurrency}`,
        );
      }
      // Over-refund fence: a refund can never exceed what the user was
      // charged for the order. The partial unique index on
      // (type='refund', reference_type='order', reference_id) already
      // limits this to a single refund per order, so the bound is the
      // whole charge.
      if (args.amountMinor > order.chargeMinor) {
        throw new RefundOrderInvalidError(
          'exceeds_charge',
          `Refund ${args.amountMinor} exceeds order charge ${order.chargeMinor}`,
        );
      }

      // CF-06: enforce the daily admin-write cap on refunds. The
      // adjustment cap query filters on `type='adjustment'`, so refund
      // rows (`type='refund'`) bypassed the magnitude circuit-breaker
      // entirely. Apply a fleet-wide refund cap (per currency, per UTC
      // day, all admins combined) under the same advisory-lock
      // derivation the adjustment / compensation writers use, so two
      // concurrent refunds in the same bucket can't jointly exceed it.
      const capMinor = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
      if (capMinor > 0n) {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${adjustmentCapLockKey(REFUND_CAP_LOCK_SCOPE, args.currency, dayStart)})`,
        );
        const [dayRow] = await tx
          .select({
            usedMinor: sql<string>`COALESCE(SUM(ABS(${creditTransactions.amountMinor}))::text, '0')`,
          })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.type, 'refund'),
              eq(creditTransactions.currency, args.currency),
              gte(creditTransactions.createdAt, dayStart),
            ),
          );
        const used = BigInt(dayRow?.usedMinor ?? '0');
        if (used + args.amountMinor > capMinor) {
          throw new DailyAdjustmentLimitError(
            args.currency,
            dayStart,
            used,
            capMinor,
            args.amountMinor,
          );
        }
      }

      // Lock the (userId, currency) row FOR UPDATE so a concurrent
      // adjustment / accrual doesn't read a stale priorBalance.
      const [existing] = await tx
        .select()
        .from(userCredits)
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
        .for('update');

      const priorBalance = existing?.balanceMinor ?? 0n;
      const newBalance = priorBalance + args.amountMinor;

      // INV-8 cross-check (money review 2026-07-08): refuse a
      // mirror-credit refund when the order's own paying deposit has
      // already been returned (or is being returned) on-chain through
      // `refundDeposit()` — that path writes no credit_transactions
      // row, so the partial unique index alone cannot exclude it. Runs
      // under the order-row lock, which every on-chain refund writer
      // also takes, so the two exits serialise. Duplicate-deposit skip
      // rows (T0-1b — a *second* deposit against a genuinely paid
      // order, paymentId ≠ the persisted paying id) do not block:
      // returning an extraneous deposit to its sender is not a refund
      // of the order. A null paying id (legacy/expired order) blocks on
      // any refunded deposit for the order — fail closed when we
      // cannot distinguish.
      const payingId = order.paymentReceivedHorizonId ?? null;
      // Match by order binding OR by the paying deposit's own payment
      // id — the latter catches skip rows recorded with orderId=null
      // (e.g. processing_error rows) that still ARE this order's
      // deposit.
      const onChainRefunds = await tx
        .select({ paymentId: paymentWatcherSkips.paymentId })
        .from(paymentWatcherSkips)
        .where(
          and(
            payingId === null
              ? eq(paymentWatcherSkips.orderId, args.orderId)
              : or(
                  eq(paymentWatcherSkips.orderId, args.orderId),
                  eq(paymentWatcherSkips.paymentId, payingId),
                ),
            inArray(paymentWatcherSkips.status, ['refunding', 'refunded']),
          ),
        );
      if (onChainRefunds.some((r) => payingId === null || r.paymentId === payingId)) {
        throw new RefundAlreadyIssuedError(args.orderId);
      }

      const [row] = await tx
        .insert(creditTransactions)
        .values({
          userId: args.userId,
          type: 'refund',
          amountMinor: args.amountMinor,
          currency: args.currency,
          referenceType: 'order',
          referenceId: args.orderId,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        })
        .returning();
      if (row === undefined) {
        throw new Error('credit_transactions insert returned no row');
      }

      if (existing === undefined) {
        await tx.insert(userCredits).values({
          userId: args.userId,
          currency: args.currency,
          balanceMinor: newBalance,
        });
      } else {
        await tx
          .update(userCredits)
          .set({ balanceMinor: newBalance, updatedAt: sql`NOW()` })
          .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)));
      }

      return {
        id: row.id,
        userId: args.userId,
        currency: args.currency,
        amountMinor: args.amountMinor,
        orderId: args.orderId,
        priorBalanceMinor: priorBalance,
        newBalanceMinor: newBalance,
        createdAt: row.createdAt,
      };
    });
  } catch (err) {
    // Partial unique index (migration 0013) rejects a duplicate
    // refund for the same order. Catch at the DB layer and surface
    // as a typed error the handler maps to 409.
    if (isDuplicateRefund(err)) {
      throw new RefundAlreadyIssuedError(args.orderId);
    }
    throw err;
  }
}

/**
 * Best-effort detection of the partial-unique-index violation from
 * migration 0013. Thin wrapper around the shared `isUniqueViolation`
 * (`db/errors.ts`), which walks the Drizzle `.cause` chain to reach
 * the underlying postgres-js `PostgresError` (`code='23505'`,
 * `constraint_name` populated) regardless of the wrapper layer the
 * ORM happens to produce. Without this, the duplicate-refund attempt
 * 500s instead of surfacing as 409 — caught by the admin-writes
 * integration suite.
 */
function isDuplicateRefund(err: unknown): boolean {
  return isUniqueViolation(err, 'credit_transactions_reference_unique');
}
