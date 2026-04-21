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
import { findPendingOrderByMemo, type Order } from '../orders/repo.js';
import { markOrderPaid, sweepExpiredOrders } from '../orders/transitions.js';
import { listAccountPayments, isMatchingIncomingPayment, type HorizonPayment } from './horizon.js';

const log = logger.child({ area: 'payment-watcher' });

/** Opaque name the cursor is persisted under. Stable across deploys. */
const WATCHER_NAME = 'stellar-deposits';

/** USDC on Stellar uses 7 decimals. 1 USDC = 10^7 stroops; 1 cent = 10^5 stroops. */
const USDC_STROOPS_PER_CENT = 100_000n;

/**
 * Parses a Horizon payment amount ("10.0000000") into BigInt stroops.
 * Horizon always returns 7 decimals for both XLM and Stellar assets.
 * Throws on malformed input — the watcher treats an unparseable
 * amount as a critical data-integrity issue (the tx went through
 * but we can't reason about value), same tier as schema drift.
 */
export function parseStroops(amount: string): bigint {
  const dot = amount.indexOf('.');
  if (dot === -1) {
    return BigInt(amount) * 10_000_000n;
  }
  const integerPart = amount.slice(0, dot) || '0';
  const decimalPart = amount
    .slice(dot + 1)
    .padEnd(7, '0')
    .slice(0, 7);
  return BigInt(integerPart) * 10_000_000n + BigInt(decimalPart);
}

/**
 * Returns true when `payment.amount` covers the face value pinned on
 * the order. USDC is treated 1:1 with USD for MVP — a $100 order
 * needs ≥100 USDC. XLM is not yet supported by the watcher because
 * we don't run a price oracle; an XLM order created today stays
 * `pending_payment` until a follow-up slice wires FX.
 *
 * For currencies other than USD, the 1:1 USDC peg means we under-
 * credit when the local currency is weaker than USD (e.g. a £100
 * order paid with 100 USDC would fail). Ops currently run Loop in
 * USD only; multi-currency requires an FX layer which is a
 * deferred item in the treasury roadmap.
 */
export function isAmountSufficient(payment: HorizonPayment, order: Order): boolean {
  if (order.paymentMethod === 'credit') {
    // Credit-funded orders don't go through the watcher — they're
    // debited inline in the handler. Reaching this branch is a bug.
    return false;
  }
  if (payment.amount === undefined) return false;
  let receivedStroops: bigint;
  try {
    receivedStroops = parseStroops(payment.amount);
  } catch {
    log.error({ amount: payment.amount, orderId: order.id }, 'Unparseable payment amount');
    return false;
  }
  if (order.paymentMethod === 'usdc') {
    // Only USD-denominated orders can be paid in USDC at 1:1 MVP.
    if (order.currency !== 'USD') return false;
    const requiredStroops = order.faceValueMinor * USDC_STROOPS_PER_CENT;
    return receivedStroops >= requiredStroops;
  }
  // xlm — deferred until an FX source lands.
  return false;
}

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
    if (!matchesUsdc && !matchesXlm) continue;
    const memo = p.transaction?.memo;
    if (typeof memo !== 'string') continue;

    const order = await findPendingOrderByMemo(memo);
    if (order === null) {
      result.unmatchedMemo++;
      continue;
    }
    result.matched++;

    if (!isAmountSufficient(p, order)) {
      log.warn(
        {
          orderId: order.id,
          expected: order.faceValueMinor.toString(),
          paymentAmount: p.amount,
          paymentMethod: order.paymentMethod,
        },
        'Payment amount does not cover order face value',
      );
      result.skippedAmount++;
      continue;
    }

    const transitioned = await markOrderPaid(order.id);
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
  }

  return result;
}

/**
 * Periodic loop wrapper around `runPaymentWatcherTick`. Swallows
 * per-tick errors so a transient Horizon blip doesn't kill the
 * interval — each tick is independent, and the next retry picks up
 * from the last persisted cursor.
 */
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let expirySweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How old a `pending_payment` order must be before the expiry sweep
 * transitions it to `expired`. 24h is conservative — on-chain
 * payments typically land in minutes, but a user who drafted an
 * order and walked away should see "expired" the next day rather
 * than a dead-looking row forever.
 */
const PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** How often the expiry sweep runs. 5 min is generous given 24h horizon. */
const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startPaymentWatcher(args: {
  account: string;
  usdcIssuer?: string | undefined;
  intervalMs: number;
  limit?: number;
}): void {
  if (watcherTimer !== null) return;
  log.info({ intervalMs: args.intervalMs }, 'Starting payment watcher');
  const tick = async (): Promise<void> => {
    try {
      const r = await runPaymentWatcherTick({
        account: args.account,
        ...(args.usdcIssuer !== undefined ? { usdcIssuer: args.usdcIssuer } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (r.scanned > 0 || r.paid > 0 || r.skippedAmount > 0) {
        log.info(r, 'Payment watcher tick complete');
      }
    } catch (err) {
      log.error({ err }, 'Payment watcher tick failed');
    }
  };
  const expirySweep = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - PAYMENT_EXPIRY_MS);
      const n = await sweepExpiredOrders(cutoff);
      if (n > 0) {
        log.info({ swept: n }, 'Marked abandoned pending_payment orders as expired');
      }
    } catch (err) {
      log.error({ err }, 'Expiry sweep failed');
    }
  };
  // Kick off an immediate first tick so restart latency doesn't leave
  // fresh deposits unprocessed for a full interval.
  void tick();
  void expirySweep();
  watcherTimer = setInterval(() => void tick(), args.intervalMs);
  watcherTimer.unref();
  expirySweepTimer = setInterval(() => void expirySweep(), EXPIRY_SWEEP_INTERVAL_MS);
  expirySweepTimer.unref();
}

export function stopPaymentWatcher(): void {
  if (expirySweepTimer !== null) {
    clearInterval(expirySweepTimer);
    expirySweepTimer = null;
  }
  if (watcherTimer === null) return;
  clearInterval(watcherTimer);
  watcherTimer = null;
  log.info('Payment watcher stopped');
}
