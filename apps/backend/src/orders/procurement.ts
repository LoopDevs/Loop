/**
 * Procurement worker (ADR 010).
 *
 * Picks up `paid` orders, places the wholesale gift-card purchase
 * against CTX using the operator pool (ADR 013), and transitions
 * through `procuring` → `fulfilled` (or `failed`). Each successful
 * fulfillment triggers the ADR 009 cashback capture inside
 * `markOrderFulfilled`.
 *
 * Run model: a periodic job picks up to N paid orders per tick. No
 * per-order locking — the `markOrderProcuring` state-guarded UPDATE
 * is the lock. Two workers racing on the same order: whichever wins
 * the UPDATE proceeds; the loser gets null and moves on to the next.
 *
 * Not wired into `index.ts` yet — the interval loop lands alongside
 * the payment watcher's wiring once operators have dry-run both
 * against testnet.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { markOrderProcuring, markOrderFulfilled, markOrderFailed } from './transitions.js';
import type { Order } from './repo.js';
import { operatorFetch, OperatorPoolUnavailableError } from '../ctx/operator-pool.js';
import { upstreamUrl } from '../upstream.js';

const log = logger.child({ area: 'procurement' });

/**
 * CTX response shape for POST /gift-cards. We only pin the fields
 * the worker needs — `id` to persist as `ctx_order_id`. Narrow parse
 * so a schema drift loud-fails the procurement, rather than silently
 * writing an undefined id.
 */
const CtxGiftCardResponse = z.object({
  id: z.string().min(1),
});

/**
 * CTX response shape for GET /gift-cards/:id, narrowed to the
 * redemption fields we surface to the user. All fields are optional
 * — some merchant types redeem by URL + challenge, others by a
 * static code with or without a PIN.
 */
const CtxGiftCardDetailResponse = z.object({
  redeemCode: z.string().optional(),
  redeemPin: z.string().optional(),
  redeemUrl: z.string().url().optional(),
  code: z.string().optional(),
  pin: z.string().optional(),
  url: z.string().url().optional(),
});

/**
 * Fetches the gift-card detail from CTX and collapses its various
 * field aliases into our internal `redeemCode / redeemPin / redeemUrl`
 * shape. CTX has been seen to use both `redeemCode` / `code` in the
 * wild depending on endpoint version; accept either.
 */
async function fetchRedemption(ctxOrderId: string): Promise<{
  code: string | null;
  pin: string | null;
  url: string | null;
}> {
  const res = await operatorFetch(upstreamUrl(`/gift-cards/${encodeURIComponent(ctxOrderId)}`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    log.warn(
      { ctxOrderId, status: res.status },
      'CTX gift-card detail fetch returned non-ok; persisting order without redemption payload',
    );
    return { code: null, pin: null, url: null };
  }
  const raw = await res.json();
  const parsed = CtxGiftCardDetailResponse.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { ctxOrderId, issues: parsed.error.issues },
      'CTX gift-card detail schema mismatch; persisting order without redemption payload',
    );
    return { code: null, pin: null, url: null };
  }
  return {
    code: parsed.data.redeemCode ?? parsed.data.code ?? null,
    pin: parsed.data.redeemPin ?? parsed.data.pin ?? null,
    url: parsed.data.redeemUrl ?? parsed.data.url ?? null,
  };
}

export interface ProcurementTickResult {
  picked: number;
  fulfilled: number;
  failed: number;
  skipped: number;
}

/**
 * Attempts procurement on a single order. Returns the outcome label
 * so callers can increment their batch counters.
 */
async function procureOne(order: Order): Promise<'fulfilled' | 'failed' | 'skipped'> {
  // Pick an operator before we flip state — the WHERE-state guard
  // means the UPDATE is our "lock", and we want to pin the operator
  // id alongside that move. A crash between this UPDATE and the
  // fetch leaves the order `procuring` with no ctx_order_id; an
  // operator-recovery sweep (deferred) will later re-try or fail.
  //
  // operatorFetch itself picks a healthy operator per request, so
  // the `ctxOperatorId` we stash is a best-effort audit label —
  // we pick "primary" as a placeholder the recovery sweep can join
  // against.
  const transitioned = await markOrderProcuring(order.id, { ctxOperatorId: 'pool' });
  if (transitioned === null) {
    // Another worker already claimed it; skip.
    return 'skipped';
  }

  try {
    const res = await operatorFetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cryptoCurrency: 'XLM',
        fiatCurrency: order.currency,
        // CTX expects fiatAmount as a decimal string in the major unit.
        fiatAmount: (Number(order.faceValueMinor) / 100).toFixed(2),
        merchantId: order.merchantId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      log.error({ orderId: order.id, status: res.status, body }, 'CTX procurement returned non-ok');
      await markOrderFailed(order.id, `CTX returned ${res.status}`);
      return 'failed';
    }
    const raw = await res.json();
    const parsed = CtxGiftCardResponse.safeParse(raw);
    if (!parsed.success) {
      log.error(
        { orderId: order.id, issues: parsed.error.issues },
        'CTX procurement response schema drift',
      );
      await markOrderFailed(order.id, 'CTX response schema drift');
      return 'failed';
    }
    // Fetch the redemption payload before flipping to fulfilled so
    // the user's "Ready" screen has the code/PIN ready to display on
    // first render. A fetch failure doesn't block fulfillment — we
    // still transition and log; a follow-up can backfill later.
    const redemption = await fetchRedemption(parsed.data.id);
    const fulfilled = await markOrderFulfilled(order.id, {
      ctxOrderId: parsed.data.id,
      redemption,
    });
    if (fulfilled === null) {
      // Race — another tick fulfilled it before us. Treat as skipped
      // (the other tick did the ledger writes).
      return 'skipped';
    }
    log.info({ orderId: order.id, ctxOrderId: parsed.data.id }, 'Order fulfilled');
    return 'fulfilled';
  } catch (err) {
    if (err instanceof OperatorPoolUnavailableError) {
      log.warn({ orderId: order.id }, 'Operator pool unavailable — leaving order procuring');
      // Do NOT mark failed; operator-pool transient outage is not
      // a terminal order failure. The next tick retries. An
      // operator-recovery sweep (deferred) will flip genuinely
      // stuck rows to failed.
      return 'skipped';
    }
    log.error({ err, orderId: order.id }, 'Procurement threw unexpectedly');
    await markOrderFailed(
      order.id,
      err instanceof Error ? err.message.slice(0, 500) : 'Unknown procurement error',
    );
    return 'failed';
  }
}

/**
 * Processes up to `limit` paid orders. Oldest-first (by `paid_at`)
 * so an incident-backlog drains FIFO rather than starving early
 * orders behind newer ones.
 */
export async function runProcurementTick(
  args: { limit?: number } = {},
): Promise<ProcurementTickResult> {
  const limit = args.limit ?? 10;
  const paidOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.state, 'paid'))
    .orderBy(asc(orders.paidAt))
    .limit(limit);

  const result: ProcurementTickResult = {
    picked: paidOrders.length,
    fulfilled: 0,
    failed: 0,
    skipped: 0,
  };

  for (const order of paidOrders) {
    const outcome = await procureOne(order);
    result[outcome]++;
  }
  return result;
}

/**
 * Periodic loop wrapper around `runProcurementTick`. Swallows per-
 * tick errors so a transient DB / pool blip doesn't kill the interval
 * — paid orders remain picked up on the next tick.
 */
let procurementTimer: ReturnType<typeof setInterval> | null = null;

export function startProcurementWorker(args: { intervalMs: number; limit?: number }): void {
  if (procurementTimer !== null) return;
  log.info({ intervalMs: args.intervalMs }, 'Starting procurement worker');
  const tick = async (): Promise<void> => {
    try {
      const r = await runProcurementTick(args.limit !== undefined ? { limit: args.limit } : {});
      if (r.picked > 0) {
        log.info(r, 'Procurement tick complete');
      }
    } catch (err) {
      log.error({ err }, 'Procurement tick failed');
    }
  };
  void tick();
  procurementTimer = setInterval(() => void tick(), args.intervalMs);
  procurementTimer.unref();
}

export function stopProcurementWorker(): void {
  if (procurementTimer === null) return;
  clearInterval(procurementTimer);
  procurementTimer = null;
  log.info('Procurement worker stopped');
}
