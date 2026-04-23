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
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, userCredits } from '../db/schema.js';

export class RefundAlreadyIssuedError extends Error {
  constructor(public readonly orderId: string) {
    super(`A refund has already been issued for order ${orderId}`);
    this.name = 'RefundAlreadyIssuedError';
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

export async function applyAdminRefund(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  orderId: string;
  adminUserId: string;
}): Promise<RefundResult> {
  if (args.amountMinor <= 0n) {
    // Schema CHECK already enforces this but we fail fast with a
    // typed error rather than surfacing a pg CHECK violation.
    throw new Error('Refund amount must be positive');
  }

  try {
    return await db.transaction(async (tx) => {
      // Lock the (userId, currency) row FOR UPDATE so a concurrent
      // adjustment / accrual doesn't read a stale priorBalance.
      const [existing] = await tx
        .select()
        .from(userCredits)
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
        .for('update');

      const priorBalance = existing?.balanceMinor ?? 0n;
      const newBalance = priorBalance + args.amountMinor;

      const [row] = await tx
        .insert(creditTransactions)
        .values({
          userId: args.userId,
          type: 'refund',
          amountMinor: args.amountMinor,
          currency: args.currency,
          referenceType: 'order',
          referenceId: args.orderId,
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
 * migration 0013. postgres-js surfaces a Postgres error with
 * `code='23505'` (unique_violation) and `constraint_name` populated.
 */
function isDuplicateRefund(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; constraint_name?: string };
  return e.code === '23505' && e.constraint_name === 'credit_transactions_reference_unique';
}
