/**
 * Loop-native create-order pre-flight DB checks (ADR 010 / 015).
 *
 * Two read-only helpers lifted out of `./loop-handler.ts` so the
 * create-handler file stays focused on request shape, FX-pinning, and
 * response building rather than carrying drizzle imports for two
 * single-row reads.
 *
 *   - `hasSufficientCredit` — the pre-write balance check for
 *     `paymentMethod='credit'` orders. The actual debit is FOR-UPDATE-
 *     guarded inside `repo.createOrder`; this is the friendly 400
 *     before the txn so the client gets a clear "INSUFFICIENT_CREDIT"
 *     rather than a 500 on a unique-violation race.
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
 * true when the balance covers the order. Called for credit-funded
 * orders before writing the row — the actual debit happens later on
 * payment watcher transition, inside the same txn as the state move
 * to `paid`.
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
