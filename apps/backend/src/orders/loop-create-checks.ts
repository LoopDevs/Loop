/**
 * Loop-native create-order pre-flight DB checks (ADR 010 / 015).
 *
 * Two read-only helpers lifted out of `./loop-handler.ts` so the
 * create-handler file stays focused on request shape, FX-pinning, and
 * response building rather than carrying drizzle imports for two
 * single-row reads.
 *
 *   - `hasSufficientCredit` — a read-only balance check for
 *     `paymentMethod='credit'` orders. NOT currently wired into the
 *     create path: the create handler no longer runs a pre-check
 *     (removed in the tranche-1 audit remediation). The sole balance
 *     guard is now the FOR UPDATE re-read inside `repo.createOrder`'s
 *     credit txn, which throws `InsufficientCreditError` (mapped to a
 *     400) when the live balance is below the charge. Retained as a
 *     reusable, unit-tested helper.
 *   - `isFirstLoopAssetOrder` — true when the user has never placed a
 *     `paymentMethod='loop_asset'` order before. Drives the one-shot
 *     `notifyFirstCashbackRecycled` Discord milestone (the user has
 *     graduated from earning cashback to spending it).
 *
 * Both queries are scoped to a single user row so they're constant-
 * time on a user with arbitrary historical volume.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, userCredits } from '../db/schema.js';

/**
 * Verifies the user has at least `amountMinor` in `currency`. Returns
 * true when the balance covers the order. A read-only helper: it is
 * NOT currently called on the create path — the authoritative check
 * is the FOR UPDATE re-read inside the credit-order txn
 * (`repo-credit-order.insertCreditOrderTxn`), which throws
 * `InsufficientCreditError` if the live balance is short.
 */
export async function hasSufficientCredit(
  userId: string,
  currency: string,
  amountMinor: bigint,
): Promise<boolean> {
  const row = await db
    .select({ balance: sql<string>`${userCredits.balanceMinor}::text` })
    .from(userCredits)
    .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, currency)));
  const balanceStr = row[0]?.balance ?? '0';
  return BigInt(balanceStr) >= amountMinor;
}

/**
 * True when the user has zero prior loop_asset orders (any state).
 * Used to distinguish the first-recycle milestone from ongoing
 * recycling, so `notifyFirstCashbackRecycled` only fires once per
 * user. LIMIT 1 so the query is constant-time regardless of how
 * much loop_asset volume the user has accumulated.
 */
export async function isFirstLoopAssetOrder(userId: string): Promise<boolean> {
  const row = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.paymentMethod, 'loop_asset')))
    .limit(1);
  return row.length === 0;
}
