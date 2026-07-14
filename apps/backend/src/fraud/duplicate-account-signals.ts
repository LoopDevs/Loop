/**
 * Duplicate-account detection — funding-source-reuse signal (ADR 045, B-3).
 *
 * Phase-1 detector: when the same on-chain Stellar account funds paid
 * orders for two DISTINCT Loop userIds, that's a real signal that one
 * actor is operating multiple Loop accounts. Flag-only — this module
 * never blocks, revokes, or otherwise acts on either account; it
 * writes a row to `fraud_signals` for ops review and pages Discord on
 * a FRESH signal (never re-pages for an already-known pair).
 *
 * Called from `payments/watcher.ts` AFTER `markOrderPaid` commits. The
 * caller awaits it, but it runs strictly OUTSIDE (never inside) the
 * money transition, so it can never affect that outcome. Every failure
 * path in this module logs and returns; it must not throw past its
 * caller, because by the time it runs the order is already paid and
 * there is no gate left to close (contrast with `fraud/velocity.ts`,
 * which fails CLOSED because it runs BEFORE the write it's guarding).
 */
import { and, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, fraudSignals } from '../db/schema.js';
import { logger } from '../logger.js';
import { notifyDuplicateAccountSignal } from '../discord.js';

const log = logger.child({ module: 'fraud-duplicate-account' });

/**
 * Cap on distinct related users considered per call. A funding source
 * that has paid into a large number of distinct accounts is already a
 * loud signal after the first handful — no need to enumerate further,
 * and it keeps the query (+ the fan-out of one INSERT per related
 * user) bounded.
 */
const RELATED_USER_LIMIT = 5;

/**
 * Orders `userId`/`relatedUserId` into a stable pair regardless of
 * which side's order triggered detection first, so the same pair of
 * accounts sharing a funding source always resolves to ONE row under
 * `fraud_signals_type_user_related_unique` — not one per direction.
 */
function canonicalPair(a: string, b: string): [primary: string, related: string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Looks for other users' paid+ orders funded from `sourceAccount` and
 * records a flag (+ a Discord page on first occurrence) for each
 * distinct match. Best-effort: any failure is logged and swallowed —
 * see the module doc comment for why this must never throw.
 */
export async function checkDuplicateFundingSource(args: {
  userId: string;
  orderId: string;
  sourceAccount: string;
}): Promise<void> {
  const { userId, orderId, sourceAccount } = args;
  if (sourceAccount.length === 0) return;

  let relatedRows: Array<{ userId: string; id: string }>;
  try {
    relatedRows = await db
      // `DISTINCT ON (user_id)` so `RELATED_USER_LIMIT` bounds the number
      // of distinct related USERS, which is the cap's stated intent — not
      // the raw order-row count. A plain `LIMIT` on the unaggregated rows
      // lets a SINGLE related user with many orders from this source fill
      // the limit and crowd out every OTHER related user, silently
      // under-counting the funding-source-reuse signal (the exact opposite
      // of what the detector is for). The `ORDER BY user_id, id` both
      // satisfies Postgres's DISTINCT-ON leading-column rule and makes the
      // one example order id kept per user deterministic (lowest id) for
      // the evidence blob.
      .selectDistinctOn([orders.userId], { userId: orders.userId, id: orders.id })
      .from(orders)
      .where(
        and(
          sql`${orders.paymentReceivedPayment} ->> 'from' = ${sourceAccount}`,
          ne(orders.userId, userId),
        ),
      )
      .orderBy(orders.userId, orders.id)
      .limit(RELATED_USER_LIMIT);
  } catch (err) {
    log.error(
      { err, userId, orderId },
      'duplicate-account funding-source lookup failed — skipping (detection-only, non-blocking)',
    );
    return;
  }

  // De-dupe to distinct related userIds (a related user could have
  // multiple orders funded from the same source; we only need one
  // example order id per pair for the evidence blob).
  const distinctRelated = new Map<string, string>();
  for (const row of relatedRows) {
    if (!distinctRelated.has(row.userId)) distinctRelated.set(row.userId, row.id);
  }
  if (distinctRelated.size === 0) return;

  for (const [relatedUserId, relatedOrderId] of distinctRelated) {
    const [primaryUserId, pairRelatedUserId] = canonicalPair(userId, relatedUserId);
    try {
      const inserted = await db
        .insert(fraudSignals)
        .values({
          signalType: 'shared_funding_source',
          userId: primaryUserId,
          relatedUserId: pairRelatedUserId,
          detail: { sourceAccount, orderId, relatedOrderId },
        })
        .onConflictDoNothing({
          target: [fraudSignals.signalType, fraudSignals.userId, fraudSignals.relatedUserId],
        })
        .returning({ id: fraudSignals.id });

      if (inserted.length > 0) {
        // Fresh signal — page ops. A conflict (already-known pair)
        // stays quiet on purpose (ADR 045: one page per pair, not one
        // per co-occurring order).
        notifyDuplicateAccountSignal({
          userId: primaryUserId,
          relatedUserId: pairRelatedUserId,
          sourceAccount,
          orderId,
          relatedOrderId,
        });
      }
    } catch (err) {
      log.error(
        { err, userId: primaryUserId, relatedUserId: pairRelatedUserId },
        'failed to record duplicate-account signal row — skipping (detection-only, non-blocking)',
      );
    }
  }
}
