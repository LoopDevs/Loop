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
import { listAccountPayments, isMatchingIncomingPayment, type HorizonPayment } from './horizon.js';
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { parseStroops } from './stroops.js';
import { isAmountSufficient } from './amount-sufficient.js';
import { recordSkip, retrySkippedPayments, type RetryOutcome } from './skipped-payments.js';

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
  /** Payments whose processing threw an unexpected error this tick. */
  errors: number;
  /** Previously-skipped deposits recovered by this tick's sweep. */
  skipsRecovered: number;
}

/** A4-107 asset tag carried from match to validation. */
type MatchedAsset =
  | { kind: 'usdc' }
  | { kind: 'xlm' }
  | { kind: 'loop_asset'; code: LoopAssetCode };

type ProcessOutcome =
  | { kind: 'no_match' }
  | { kind: 'no_memo' }
  | { kind: 'unmatched'; memo: string }
  | { kind: 'paid'; orderId: string; memo: string }
  | { kind: 'already_paid'; orderId: string; memo: string }
  | {
      kind: 'skip';
      reason: 'asset_mismatch' | 'amount_insufficient' | 'missing_credit_row';
      orderId: string;
      memo: string;
      detail?: string | undefined;
    };

/**
 * Per-payment processor — the single implementation shared by the
 * live tick loop and the skipped-deposit retry sweep, so a retried
 * payment replays exactly the matching/validation/transition logic
 * a fresh one gets.
 */
async function processPayment(
  p: HorizonPayment,
  args: { account: string; usdcIssuer?: string | undefined },
  loopAssets: ReturnType<typeof configuredLoopPayableAssets>,
): Promise<ProcessOutcome> {
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
  if (!matchesUsdc && !matchesXlm && loopAssetCode === null) return { kind: 'no_match' };
  // A4-107: tag the matched asset so amount-sufficient can
  // validate the deposit's asset against the order's
  // `paymentMethod` enum. Earlier code passed only
  // `loopAssetCode`, so a USDC order satisfied by an XLM
  // deposit silently parsed 7-decimal at 1:1 and accepted a
  // catastrophically underpaying tx (10 XLM ≈ $1 funding a
  // $10 USDC order). LOOP-asset wins over USDC + XLM because
  // it's the most specific match (issuer-pinned).
  const matchedAsset: MatchedAsset =
    loopAssetCode !== null
      ? { kind: 'loop_asset', code: loopAssetCode }
      : matchesUsdc
        ? { kind: 'usdc' }
        : { kind: 'xlm' };
  const memo = p.transaction?.memo;
  if (typeof memo !== 'string') return { kind: 'no_memo' };

  const order = await findPendingOrderByMemo(memo);
  if (order === null) return { kind: 'unmatched', memo };

  // A4-107: enforce asset/method match BEFORE size check. If the
  // deposit asset doesn't match the order's `paymentMethod`, no
  // amount of size-check arithmetic should mark the order paid.
  const expectedKind: MatchedAsset['kind'] =
    order.paymentMethod === 'usdc'
      ? 'usdc'
      : order.paymentMethod === 'xlm'
        ? 'xlm'
        : order.paymentMethod === 'loop_asset'
          ? 'loop_asset'
          : 'usdc'; // 'credit' is debited inline; reaching the watcher with credit is a bug.
  if (matchedAsset.kind !== expectedKind) {
    log.warn(
      {
        orderId: order.id,
        paymentMethod: order.paymentMethod,
        matchedAsset: matchedAsset.kind,
        paymentId: p.id,
      },
      'A4-107: deposit asset does not match order payment_method — rejecting',
    );
    return {
      kind: 'skip',
      reason: 'asset_mismatch',
      orderId: order.id,
      memo,
      detail: `deposit ${matchedAsset.kind} vs order ${order.paymentMethod}`,
    };
  }

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
    return { kind: 'skip', reason: 'amount_insufficient', orderId: order.id, memo };
  }

  let transitioned;
  try {
    transitioned = await markOrderPaid(order.id);
  } catch (err) {
    if (err instanceof LoopAssetMissingCreditRowError) {
      // A4-110 defence: state corruption (user holds on-chain
      // LOOP without matching off-chain user_credits row). The
      // order stays in pending_payment and the skip row recorded
      // by the caller keeps re-evaluating it each tick — the
      // cursor has already moved past this payment, so without
      // the skip row it would never be looked at again.
      log.error(
        {
          orderId: err.orderId,
          userId: err.userId,
          currency: err.currency,
          paymentId: p.id,
          memo,
        },
        'LOOP-asset payment arrived but user has no matching user_credits row — recorded for retry + ops investigation',
      );
      return {
        kind: 'skip',
        reason: 'missing_credit_row',
        orderId: order.id,
        memo,
        detail: `user ${err.userId} missing ${err.currency} credit row`,
      };
    }
    throw err;
  }
  if (transitioned !== null) {
    log.info(
      { orderId: order.id, paymentId: p.id, memo },
      'Order transitioned pending_payment → paid',
    );
    return { kind: 'paid', orderId: order.id, memo };
  }
  return { kind: 'already_paid', orderId: order.id, memo };
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
    errors: 0,
    skipsRecovered: 0,
  };

  // ADR 015 — extend the asset-match allowlist to cover every LOOP
  // asset the operator has issued + configured. The allowlist is
  // computed fresh every tick so an operator hot-adding an issuer
  // env var + restarting takes effect at the next watcher tick,
  // no redeploy dance.
  const loopAssets = configuredLoopPayableAssets();

  // Re-evaluate previously-skipped deposits FIRST (comprehensive-
  // audit CRIT #1) — the cursor has already moved past them, so the
  // skip table is the only path back. The sweep never throws; a
  // failing row is left pending for the next tick.
  const sweep = await retrySkippedPayments(async (payment): Promise<RetryOutcome> => {
    const o = await processPayment(payment, args, loopAssets);
    switch (o.kind) {
      case 'paid':
        return { kind: 'paid' };
      case 'already_paid':
        return { kind: 'already_paid' };
      case 'unmatched':
        // The order left pending_payment without this deposit —
        // expiry, or another payment won the race.
        return { kind: 'order_gone' };
      case 'skip':
        return { kind: 'skip', reason: o.reason, orderId: o.orderId, detail: o.detail };
      case 'no_match':
      case 'no_memo':
        // A recorded row matched when it was written; if it no
        // longer does (e.g. a LOOP issuer env var was removed),
        // keep retrying under the attempt budget rather than
        // abandoning funds on a config blip.
        return {
          kind: 'skip',
          reason: 'processing_error',
          orderId: null,
          detail: 'payment no longer matches deposit filters',
        };
    }
  });
  result.skipsRecovered = sweep.resolved;
  result.paid += sweep.resolved;

  for (const p of page.records) {
    let outcome: ProcessOutcome;
    try {
      outcome = await processPayment(p, args, loopAssets);
    } catch (err) {
      // CRIT #2 (poison-pill isolation): one payment whose
      // processing throws must not wedge the tick — before this
      // catch, the rethrow aborted the tick before the cursor
      // write, so every subsequent tick re-read the same page and
      // threw again, halting deposit processing for ALL users.
      // Record the skip (so the payment is retried under the
      // attempt budget) and move on.
      const memo = p.transaction?.memo;
      log.error(
        { err, paymentId: p.id, memo },
        'Payment processing threw — recording skip and continuing tick',
      );
      result.errors++;
      await recordSkip({
        payment: p,
        memo: typeof memo === 'string' ? memo : '',
        orderId: null,
        reason: 'processing_error',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    switch (outcome.kind) {
      case 'no_match':
      case 'no_memo':
        break;
      case 'unmatched':
        result.unmatchedMemo++;
        break;
      case 'paid':
        result.matched++;
        result.paid++;
        break;
      case 'already_paid':
        result.matched++;
        break;
      case 'skip':
        result.matched++;
        result.skippedAmount++;
        // Persisted BEFORE the cursor advances (CRIT #1) — if this
        // insert throws, the tick aborts with the cursor parked
        // before this payment, which is safe (page re-read next
        // tick). Without the row, advancing the cursor would orphan
        // the deposit forever.
        await recordSkip({
          payment: p,
          memo: outcome.memo,
          orderId: outcome.orderId,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        break;
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
