/**
 * Admin withdrawal writer (A2-901 / ADR-024).
 *
 * Last missing `credit_transactions.type` writer. The enum lists
 * 'withdrawal' since day one but no production code emitted one — a
 * user with cashback balance had no path to convert it back into an
 * on-chain payout.
 *
 * This module is the ledger primitive only — admin handler + Discord
 * fanout + idempotency wrapper live in `admin/withdrawals.ts` (the
 * next PR in the chain).
 *
 * Semantics (per ADR-024 §3):
 *
 *   - Atomic two-row write inside one DB transaction:
 *       1. SELECT ... FOR UPDATE on user_credits — lock the balance.
 *       2. Reject with InsufficientBalanceError if balance < amount.
 *       3. INSERT pending_payouts (kind='withdrawal', order_id NULL,
 *          asset_code/issuer/to/memo from intent) RETURNING id.
 *       4. INSERT credit_transactions (type='withdrawal', amount=
 *          -amount, reference_type='payout', reference_id=<payout id>,
 *          reason).
 *       5. UPDATE user_credits balance_minor -= amount.
 *
 * All-or-nothing under db.transaction so a step-4 or step-5 crash
 * rolls back the payout row too — no orphaned credit-tx, no
 * orphaned payout.
 *
 * The partial unique index extended in migration 0022
 * (`credit_transactions_reference_unique` scoped to include
 * `type='withdrawal'`) catches operator-error retries that bypass
 * the ADR-017 idempotency layer — surfaces as
 * `WithdrawalAlreadyIssuedError`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, pendingPayouts, userCredits } from '../db/schema.js';
import { InsufficientBalanceError } from './adjustments.js';

export class WithdrawalAlreadyIssuedError extends Error {
  constructor(public readonly payoutId: string) {
    super(`A withdrawal credit-tx has already been issued for payout ${payoutId}`);
    this.name = 'WithdrawalAlreadyIssuedError';
  }
}

export interface WithdrawalIntent {
  /** LOOP asset code being burned off-chain — `USDLOOP`, `GBPLOOP`, `EURLOOP`. */
  assetCode: string;
  /** Issuer pinned at write-time so a later issuer rotate doesn't redirect in-flight payouts. */
  assetIssuer: string;
  /** Destination Stellar address — the user's linked wallet. */
  toAddress: string;
  /** Amount in stroops (7-decimal Stellar minor unit). */
  amountStroops: bigint;
  /** Memo text for the on-chain payment (~28 ASCII chars). */
  memoText: string;
}

export interface WithdrawalResult {
  /** credit_transactions.id of the new ledger row. */
  id: string;
  /** pending_payouts.id of the queued on-chain payout. */
  payoutId: string;
  userId: string;
  currency: string;
  /** Unsigned magnitude. The stored credit-tx row is negative. */
  amountMinor: bigint;
  /** Balance BEFORE the debit (audit trail). */
  priorBalanceMinor: bigint;
  /** Balance AFTER the debit. */
  newBalanceMinor: bigint;
  createdAt: Date;
}

/**
 * Apply an admin-initiated withdrawal: debit the user's off-chain
 * cashback balance and queue the matching on-chain payout.
 *
 * Throws:
 *   - `InsufficientBalanceError` — balance < requested amount.
 *   - `WithdrawalAlreadyIssuedError` — partial-unique index says
 *     a credit-tx already references this payout id.
 *   - generic Error — `Withdrawal amount must be positive` if the
 *     caller passes 0 or negative; the schema CHECK enforces this
 *     too but we fail fast with a typed message.
 */
export async function applyAdminWithdrawal(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  intent: WithdrawalIntent;
  /** Operator reason persisted on the credit_transactions row (A2-908). */
  reason: string;
}): Promise<WithdrawalResult> {
  if (args.amountMinor <= 0n) {
    throw new Error('Withdrawal amount must be positive');
  }

  try {
    return await db.transaction(async (tx) => {
      // Lock the (userId, currency) balance row before reading +
      // checking. A concurrent admin adjustment / accrual cannot
      // race past this point until the txn commits.
      const [existing] = await tx
        .select()
        .from(userCredits)
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
        .for('update');

      const priorBalance = existing?.balanceMinor ?? 0n;
      if (priorBalance < args.amountMinor) {
        throw new InsufficientBalanceError(args.currency, priorBalance, args.amountMinor);
      }

      // Step 1 of the two-row write: queue the on-chain payout.
      // `kind='withdrawal'` + `order_id` NULL — schema CHECK
      // rejects the wrong combinations.
      const [payout] = await tx
        .insert(pendingPayouts)
        .values({
          userId: args.userId,
          kind: 'withdrawal',
          assetCode: args.intent.assetCode,
          assetIssuer: args.intent.assetIssuer,
          toAddress: args.intent.toAddress,
          amountStroops: args.intent.amountStroops,
          memoText: args.intent.memoText,
        })
        .returning();
      if (payout === undefined) {
        throw new Error('pending_payouts insert returned no row');
      }

      // Step 2: ledger entry referencing the just-queued payout.
      // The partial unique index on
      // (type='withdrawal', reference_type='payout', reference_id)
      // — migration 0022 — catches operator-error retries.
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          userId: args.userId,
          type: 'withdrawal',
          // Negative — schema CHECK rejects positive `withdrawal`.
          amountMinor: -args.amountMinor,
          currency: args.currency,
          referenceType: 'payout',
          referenceId: payout.id,
          reason: args.reason,
        })
        .returning();
      if (creditTx === undefined) {
        throw new Error('credit_transactions insert returned no row');
      }

      // Step 3: decrement the locked balance row.
      const newBalance = priorBalance - args.amountMinor;
      if (existing === undefined) {
        // Edge case: no prior user_credits row but balance check
        // passed — only possible when amountMinor is 0n, which we
        // rejected above. Defensive insert at 0 keeps the ledger
        // ↔ user_credits sum invariant intact for the reconciliation
        // surface.
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
        id: creditTx.id,
        payoutId: payout.id,
        userId: args.userId,
        currency: args.currency,
        amountMinor: args.amountMinor,
        priorBalanceMinor: priorBalance,
        newBalanceMinor: newBalance,
        createdAt: creditTx.createdAt,
      };
    });
  } catch (err) {
    if (isDuplicateWithdrawal(err)) {
      // The credit-tx insert hit the partial unique index. The
      // payout row was inserted in the same txn and rolled back
      // alongside, so there's no orphan to clean up.
      throw new WithdrawalAlreadyIssuedError(extractPayoutId(err) ?? '<unknown>');
    }
    throw err;
  }
}

/**
 * Best-effort detection of the partial-unique-index violation from
 * migration 0022. postgres-js surfaces a Postgres error with
 * `code='23505'` (unique_violation) and `constraint_name` populated.
 */
function isDuplicateWithdrawal(err: unknown): boolean {
  // Drizzle wraps `PostgresError` in `DrizzleQueryError`; walk the
  // cause chain to find the underlying postgres-js error. Without
  // this the duplicate-withdrawal attempt 500s instead of surfacing
  // as 409 WITHDRAWAL_ALREADY_ISSUED — caught by the admin-writes
  // integration suite.
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const e = cur as Error & { code?: string; constraint_name?: string };
    if (e.code === '23505' && e.constraint_name === 'credit_transactions_reference_unique') {
      return true;
    }
    cur = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * On a partial-unique violation, the payout id we tried to write is
 * embedded in the pg error's `detail` field
 * (`Key (type, reference_type, reference_id)=(withdrawal, payout, <id>)`).
 * Extract it for the typed error so the handler can echo it back.
 * Same cause-chain walk as `isDuplicateWithdrawal` — the `detail`
 * field lives on the wrapped postgres-js error, not the top-level
 * `DrizzleQueryError`.
 */
function extractPayoutId(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const e = cur as Error & { detail?: string };
    if (e.detail !== undefined) {
      const match = /\(withdrawal, payout, ([^)]+)\)/.exec(e.detail);
      if (match?.[1] !== undefined) return match[1];
    }
    cur = (e as { cause?: unknown }).cause;
  }
  return null;
}
