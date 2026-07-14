/**
 * Loop-native create-order pre-flight DB checks (ADR 010 / 015).
 *
 * A read-only helper lifted out of `./loop-handler.ts` so the
 * create-handler file stays focused on request shape, FX-pinning, and
 * response building rather than carrying a drizzle import for a
 * single-row read.
 *
 *   - `isFirstLoopAssetOrder` — true when the user has never placed a
 *     `paymentMethod='loop_asset'` order before. Drives the one-shot
 *     `notifyFirstCashbackRecycled` Discord milestone (the user has
 *     graduated from earning cashback to spending it).
 *
 * The query is scoped to a single user row so it's constant-time on a
 * user with arbitrary historical volume.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';

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
