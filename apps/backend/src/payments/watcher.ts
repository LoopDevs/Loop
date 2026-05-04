/**
 * Payment watcher (ADR 010).
 *
 * Polls Stellar Horizon for incoming payments to Loop's deposit
 * address, matches each payment's memo to a pending_payment order,
 * validates the amount, and transitions the order to `paid`. Every
 * step is idempotent — a replayed cursor, a double-dispatched tick,
 * or a restart in the middle of processing re-runs cleanly.
 *
 * This module exposes the primitives:
 *   - `runPaymentWatcherTick()` — one full pass (cursor → poll →
 *     match → transition → persist cursor). Called from a scheduled
 *     interval or manually from an admin recovery tool.
 *   - `isAmountSufficient(payment, order)` — asset-aware amount
 *     check. Pure (no I/O) so callers can unit-test the policy
 *     without a DB.
 *
 * The scheduled interval is **not** started in this PR — `index.ts`
 * wiring lands in a follow-up once an operator has verified the
 * watcher against testnet.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { watcherCursors } from '../db/schema.js';
import { logger } from '../logger.js';
import { findPendingOrderByMemo } from '../orders/repo.js';
import { markOrderPaid, LoopAssetMissingCreditRowError } from '../orders/transitions.js';
import { listAccountPayments, isMatchingIncomingPayment } from './horizon.js';
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { parseStroops } from './stroops.js';
import { isAmountSufficient } from './amount-sufficient.js';

const log = logger.child({ area: 'payment-watcher' });

/** Opaque name the cursor is persisted under. Stable across deploys. */
const WATCHER_NAME = 'stellar-deposits';

// `parseStroops` lives in `./stroops.ts` — shared with
// `./horizon-balances.ts` to prevent drift between the two call
// sites. Re-exported here so the watcher's existing public surface
// (consumed by `./__tests__/watcher.test.ts`) keeps working.
export { parseStroops };

// `isAmountSufficient` (A2-619 payment-amount validation gate)
// lives in `./amount-sufficient.ts`. Re-exported here so the test
// suite (`./__tests__/watcher.test.ts` imports from `../watcher.js`)
// keeps working without re-targeting.
export { isAmountSufficient } from './amount-sufficient.js';

/**
 * Loads the last-processed cursor for this watcher. Null on first
 * run; on a subsequent tick we resume from the persisted value.
 */
async function readCursor(): Promise<string | null> {
  const row = await db.query.watcherCursors.findFirst({
    where: sql`${watcherCursors.name} = ${WATCHER_NAME}`,
  });
  return row?.cursor ?? null;
}

/**
 * Writes the cursor we advanced to. Upsert keyed on `name` so first-
 * run doesn't need a migration seed.
 */
async function writeCursor(cursor: string): Promise<void> {
  await db
    .insert(watcherCursors)
    .values({ name: WATCHER_NAME, cursor })
    .onConflictDoUpdate({
      target: watcherCursors.name,
      set: { cursor, updatedAt: sql`NOW()` },
    });
}

/**
 * A4-105: heartbeat — bump `updated_at` on the cursor row even
 * when the tick read an empty page that didn't advance the cursor.
 * Without this, a low-volume but healthy period (no on-chain
 * deposits) leaves the cursor's updated_at frozen at the last
 * paid-order timestamp; the cursor-age watchdog (cursor-watchdog.ts)
 * then pages "watcher stuck" after 10 min of healthy idleness.
 *
 * Only fires when the row exists — first-run is gated to writeCursor
 * via the upsert above. The update is a tiny single-row touch and
 * safe to do on every tick; even a 10-second cadence is 6 writes/min.
 */
async function touchCursorUpdatedAt(): Promise<void> {
  await db
    .update(watcherCursors)
    .set({ updatedAt: sql`NOW()` })
    .where(sql`${watcherCursors.name} = ${WATCHER_NAME}`);
}

export interface TickResult {
  scanned: number;
  matched: number;
  paid: number;
  skippedAmount: number;
  unmatchedMemo: number;
}

/**
 * Single pass of the watcher. Safe to call repeatedly; idempotent
 * against a re-processed cursor. Returns counts so a caller (the
 * interval loop or an admin one-shot) can log batch health.
 *
 * Requires `LOOP_STELLAR_DEPOSIT_ADDRESS` to be set — the caller
 * is expected to pass it explicitly so this function stays pure
 * w.r.t. env and testable.
 */
export async function runPaymentWatcherTick(args: {
  account: string;
  usdcIssuer?: string | undefined;
  limit?: number;
}): Promise<TickResult> {
  const cursor = await readCursor();
  const page = await listAccountPayments({
    account: args.account,
    ...(cursor !== null ? { cursor } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

  const result: TickResult = {
    scanned: page.records.length,
    matched: 0,
    paid: 0,
    skippedAmount: 0,
    unmatchedMemo: 0,
  };

  // ADR 015 — extend the asset-match allowlist to cover every LOOP
  // asset the operator has issued + configured. The allowlist is
  // computed fresh every tick so an operator hot-adding an issuer
  // env var + restarting takes effect at the next watcher tick,
  // no redeploy dance.
  const loopAssets = configuredLoopPayableAssets();

  for (const p of page.records) {
    // USDC path — preferred for launch. Falls back to XLM check for
    // a native-asset payment; the order-level isAmountSufficient
    // will still reject it at amount-check time until FX lands.
    const matchesUsdc = isMatchingIncomingPayment(p, {
      account: args.account,
      assetCode: 'USDC',
      ...(args.usdcIssuer !== undefined ? { assetIssuer: args.usdcIssuer } : {}),
    });
    const matchesXlm = isMatchingIncomingPayment(p, {
      account: args.account,
      assetCode: null,
    });
    // A LOOP-asset match carries the code forward so the size check
    // can apply the 1:1 fiat peg (no oracle round-trip). First match
    // wins — `configuredLoopPayableAssets` enforces issuer pinning so
    // two configured LOOP assets can't collide on an asset code.
    let loopAssetCode: LoopAssetCode | null = null;
    for (const la of loopAssets) {
      if (
        isMatchingIncomingPayment(p, {
          account: args.account,
          assetCode: la.code,
          assetIssuer: la.issuer,
        })
      ) {
        loopAssetCode = la.code;
        break;
      }
    }
    if (!matchesUsdc && !matchesXlm && loopAssetCode === null) continue;
    const memo = p.transaction?.memo;
    if (typeof memo !== 'string') continue;

    const order = await findPendingOrderByMemo(memo);
    if (order === null) {
      result.unmatchedMemo++;
      continue;
    }
    result.matched++;

    if (!(await isAmountSufficient(p, order, loopAssetCode))) {
      log.warn(
        {
          orderId: order.id,
          expected: order.faceValueMinor.toString(),
          paymentAmount: p.amount,
          paymentMethod: order.paymentMethod,
          loopAssetCode,
        },
        'Payment amount does not cover order face value',
      );
      result.skippedAmount++;
      continue;
    }

    let transitioned;
    try {
      transitioned = await markOrderPaid(order.id);
    } catch (err) {
      if (err instanceof LoopAssetMissingCreditRowError) {
        // A4-110 defence: state corruption (user holds on-chain
        // LOOP without matching off-chain user_credits row).
        // Order stays in pending_payment; the next watcher tick
        // re-evaluates. Surface to ops via log + skipped counter
        // so the row doesn't silently sit forever.
        log.error(
          {
            orderId: err.orderId,
            userId: err.userId,
            currency: err.currency,
            paymentId: p.id,
            memo,
          },
          'LOOP-asset payment arrived but user has no matching user_credits row — order left pending_payment for ops investigation',
        );
        result.skippedAmount++;
        continue;
      }
      throw err;
    }
    if (transitioned !== null) {
      result.paid++;
      log.info(
        { orderId: order.id, paymentId: p.id, memo },
        'Order transitioned pending_payment → paid',
      );
    }
  }

  // Advance the cursor to the last record's paging_token when the
  // page returned any records; no records means no cursor advance.
  // Using paging_token (not nextCursor) keeps us robust to a missing
  // `_links.next.href` on a short page.
  const last = page.records[page.records.length - 1];
  if (last !== undefined) {
    await writeCursor(last.paging_token);
  } else if (page.nextCursor !== null) {
    // Empty page with an explicit next cursor — advance anyway to
    // avoid re-polling the same empty window.
    await writeCursor(page.nextCursor);
  } else {
    // A4-105: empty page with no next cursor (the typical
    // healthy-idle case at the head of the stream). Touch
    // `updated_at` so the cursor-watchdog doesn't false-positive
    // on long no-deposit periods.
    await touchCursorUpdatedAt();
  }

  return result;
}

// Cursor-age watchdog (A2-626) lives in `./cursor-watchdog.ts`.
// Re-exported here so the test suite (`./__tests__/watcher.test.ts`
// imports `__resetCursorWatchdogForTests` from `../watcher.js`)
// keeps working without re-targeting.
export { __resetCursorWatchdogForTests } from './cursor-watchdog.js';

// `startPaymentWatcher` / `stopPaymentWatcher` (the periodic-loop
// bootstrap — deposit-poll tick + expiry-sweep + cursor-age
// watchdog timers, plus the PAYMENT_EXPIRY_MS /
// EXPIRY_SWEEP_INTERVAL_MS constants) live in
// `./watcher-bootstrap.ts`. Re-exported below so
// `'../payments/watcher.js'` keeps resolving for `index.ts` and
// the test suite.
export { startPaymentWatcher, stopPaymentWatcher } from './watcher-bootstrap.js';
