/**
 * Credit-funded order creation transaction (ADR 010 / 015).
 *
 * Lifted out of `./repo.ts`. Credit-funded orders take an
 * atomically-different path from on-chain orders: insert the order
 * row, FOR UPDATE-lock the user's balance, write the negative
 * `credit_transactions` spend row, decrement the balance, and flip
 * the order to `paid` — all in one Drizzle transaction so a crash
 * mid-write either leaves the user un-debited (txn rolled back) or
 * leaves the order paid alongside its debit (committed). No
 * intermediate states.
 *
 * The on-chain branches in `createOrder` (xlm / usdc / loop_asset)
 * just insert a `pending_payment` row — no ledger touched. Pulling
 * the credit-order ladder into a sibling lets the parent
 * `createOrder` read as a clean dispatch (insert on the on-chain
 * path; delegate to this helper on the credit path).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, userCredits, creditTransactions } from '../db/schema.js';
import type { Order } from './repo.js';
import { InsufficientCreditError } from './repo-errors.js';

/**
 * The columns the `createOrder` parent computes once and passes to
 * us — these are the same `baseValues` it inserts on the on-chain
 * path, plus the derived `chargeMinor` / `chargeCurrency` /
 * `userId` we re-read for the balance lock.
 */
export interface CreditOrderBaseValues {
  userId: string;
  merchantId: string;
  faceValueMinor: bigint;
  currency: string;
  chargeMinor: bigint;
  chargeCurrency: string;
  paymentMethod: 'credit';
  paymentMemo: string | null;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  wholesaleMinor: bigint;
  userCashbackMinor: bigint;
  loopMarginMinor: bigint;
  idempotencyKey: string | null;
}

/**
 * Inserts the order row, debits the user's balance under a
 * FOR UPDATE lock, writes the spend ledger row, and flips the
 * order to `paid`. Throws `InsufficientCreditError` if the balance
 * is below the charge amount when re-read inside the txn (a race
 * past the handler's UX-only `hasSufficientCredit` pre-check).
 */
export async function insertCreditOrderTxn(values: CreditOrderBaseValues): Promise<Order> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(orders).values(values).returning();
    if (inserted === undefined) {
      throw new Error('createOrder: no row returned');
    }

    // Re-read balance under a FOR UPDATE lock. A concurrent admin
    // adjustment or another credit order against the same
    // (user, currency) row serialises through here. This is the
    // guard — the earlier `hasSufficientCredit` at the handler is a
    // UX fast-path that can be racy.
    const fresh = await tx
      .select({ balanceMinor: userCredits.balanceMinor })
      .from(userCredits)
      .where(
        and(eq(userCredits.userId, values.userId), eq(userCredits.currency, values.chargeCurrency)),
      )
      .for('update');

    const balance = fresh[0]?.balanceMinor ?? 0n;
    if (balance < values.chargeMinor) {
      throw new InsufficientCreditError();
    }

    // Ledger: type='spend' carries a NEGATIVE amount per schema CHECK
    // (`spend`/`withdrawal` amount<0). Reference this order so
    // reconciliation can trace the debit back to its cause.
    await tx.insert(creditTransactions).values({
      userId: values.userId,
      type: 'spend',
      amountMinor: -values.chargeMinor,
      currency: values.chargeCurrency,
      referenceType: 'order',
      referenceId: inserted.id,
    });

    // Balance: subtract via SQL expression rather than JS arithmetic
    // on the freshly-read value, since the lock already serialises
    // us and the DB expression is the ledger's own source of truth.
    await tx
      .update(userCredits)
      .set({ balanceMinor: sql`${userCredits.balanceMinor} - ${values.chargeMinor}` })
      .where(
        and(eq(userCredits.userId, values.userId), eq(userCredits.currency, values.chargeCurrency)),
      );

    // Transition to paid. Mirrors `markOrderPaid`'s shape but stays
    // within this txn so the debit + state flip commit together.
    const now = new Date();
    const [paid] = await tx
      .update(orders)
      .set({
        state: 'paid',
        paidAt: now,
        paymentReceivedAt: now,
      })
      .where(and(eq(orders.id, inserted.id), eq(orders.state, 'pending_payment')))
      .returning();
    if (paid === undefined) {
      // Unreachable — the row was just inserted above in the same
      // txn; nothing else can have transitioned it. Throw loudly so
      // a future refactor that breaks this invariant is obvious.
      throw new Error('createOrder: credit-order paid-transition lost race with self');
    }
    return paid;
  });
}
