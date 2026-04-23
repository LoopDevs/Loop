/**
 * Outstanding-liability reader (ADR 015).
 *
 * Sum of `user_credits.balance_minor` bucketed by currency — the
 * off-chain-ledger side of the stablecoin drift metric. Paired with
 * `getLoopAssetCirculation` (the on-chain side) in both the admin
 * drift-detection handler and the background drift watcher.
 */
import { sql } from 'drizzle-orm';
import type { HomeCurrency } from '@loop/shared';
import { db } from '../db/client.js';
import { userCredits } from '../db/schema.js';

/**
 * Sum `user_credits.balance_minor` for a single fiat. Zero-filled when
 * no user has ever held credit in that currency.
 */
export async function sumOutstandingLiability(currency: HomeCurrency): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${userCredits.balanceMinor}), 0)::text`,
    })
    .from(userCredits)
    .where(sql`${userCredits.currency} = ${currency}`);
  return BigInt(row?.total ?? '0');
}
