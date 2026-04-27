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
import { env } from '../env.js';
import { logger } from '../logger.js';
import {
  markOrderProcuring,
  markOrderFulfilled,
  markOrderFailed,
  sweepStuckProcurement,
} from './transitions.js';
import type { Order } from './repo.js';
import { operatorFetch, OperatorPoolUnavailableError } from '../ctx/operator-pool.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCashbackCredited, notifyUsdcBelowFloor } from '../discord.js';
import { getMerchants } from '../merchants/sync.js';

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

// Procurement asset-picker (USDC vs XLM rail decision + below-floor
// alert throttle) lives in `./procurement-asset-picker.ts`.
// Re-exported here so `__tests__/procurement.test.ts` keeps
// importing from the historical path without re-targeting; also
// imported locally for the runtime call site below.
export {
  pickProcurementAsset,
  __resetBelowFloorAlertForTests,
} from './procurement-asset-picker.js';
import {
  pickProcurementAsset,
  readUsdcBalanceSafely,
  shouldAlertBelowFloor,
} from './procurement-asset-picker.js';

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

  // ADR 015 — USDC is the default CTX-payment rail; XLM is the
  // break-glass path when our operator USDC balance dips below the
  // configured floor. Read the live USDC balance off Horizon only
  // when a floor is configured (no point hitting Horizon otherwise).
  // A Horizon failure resolves to `balanceStroops: null` and the
  // picker gracefully falls back to USDC — we'd rather risk an
  // over-drained USDC reserve than stall procurement entirely.
  const floorStroops = env.LOOP_STELLAR_USDC_FLOOR_STROOPS ?? null;
  const balanceStroops =
    floorStroops !== null && env.LOOP_STELLAR_DEPOSIT_ADDRESS !== undefined
      ? await readUsdcBalanceSafely(env.LOOP_STELLAR_DEPOSIT_ADDRESS)
      : null;
  const cryptoCurrency = pickProcurementAsset({
    balanceStroops,
    floorStroops,
  });
  if (cryptoCurrency === 'XLM') {
    log.warn(
      {
        orderId: order.id,
        balanceStroops: balanceStroops?.toString(),
        floorStroops: floorStroops?.toString(),
      },
      'USDC reserve below configured floor — procurement falling back to XLM',
    );
    // Discord alert throttled so a sustained below-floor condition
    // doesn't spam the channel every tick. One alert per cooldown
    // window is enough — ops acts on the first; subsequent orders
    // just confirm it's still happening, which the treasury
    // dashboard already shows.
    if (
      balanceStroops !== null &&
      floorStroops !== null &&
      env.LOOP_STELLAR_DEPOSIT_ADDRESS !== undefined &&
      shouldAlertBelowFloor(Date.now())
    ) {
      notifyUsdcBelowFloor({
        balanceStroops: balanceStroops.toString(),
        floorStroops: floorStroops.toString(),
        account: env.LOOP_STELLAR_DEPOSIT_ADDRESS,
      });
    }
  }

  try {
    const res = await operatorFetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A2-1508: pin the CTX charge to this Loop order. A 30s
        // fetch timeout + retry-on-next-tick (after
        // `sweepStuckProcurement` flips the order back) could otherwise
        // post the same purchase twice if the first call reached CTX
        // but the response was lost. The key is the Loop order id —
        // stable, unique per order, and already the audit pivot on
        // our side. CTX dedupes by this key server-side (if they
        // honour it); worst case the header is inert and we've spent
        // zero bytes of behaviour on it.
        'Idempotency-Key': order.id,
      },
      body: JSON.stringify({
        cryptoCurrency,
        fiatCurrency: order.currency,
        // CTX expects fiatAmount as a decimal string in the major unit.
        fiatAmount: (Number(order.faceValueMinor) / 100).toFixed(2),
        merchantId: order.merchantId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = scrubUpstreamBody(await res.text());
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

    // Fire the Discord "cashback credited" signal *after* the txn
    // commits — a webhook inside the transaction would stretch the DB
    // lock across the network hop. `userCashbackMinor=0` fulfillments
    // still transition cleanly on the DB side but don't earn the user
    // anything, so skip the notification too.
    if (fulfilled.userCashbackMinor > 0n) {
      const merchantName =
        getMerchants().merchantsById.get(fulfilled.merchantId)?.name ?? fulfilled.merchantId;
      notifyCashbackCredited({
        orderId: fulfilled.id,
        merchantName,
        amountMinor: fulfilled.userCashbackMinor.toString(),
        currency: fulfilled.chargeCurrency,
        userId: fulfilled.userId,
      });
    }
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
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How stale a `procuring` order must be before the recovery sweep
 * marks it failed. 15 minutes is plenty — CTX procurement in the
 * happy path completes in a few seconds; anything hanging at the
 * 15-minute mark is a crashed worker or a deep upstream issue the
 * user shouldn't be left waiting on.
 */
const PROCUREMENT_TIMEOUT_MS = 15 * 60 * 1000;

/** How often the recovery sweep runs. Once a minute is generous. */
const SWEEP_INTERVAL_MS = 60 * 1000;

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
  const sweep = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - PROCUREMENT_TIMEOUT_MS);
      const n = await sweepStuckProcurement(cutoff);
      if (n > 0) {
        log.warn({ swept: n }, 'Marked stuck procuring orders as failed');
      }
    } catch (err) {
      log.error({ err }, 'Stuck-procurement sweep failed');
    }
  };
  void tick();
  void sweep();
  procurementTimer = setInterval(() => void tick(), args.intervalMs);
  procurementTimer.unref();
  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopProcurementWorker(): void {
  if (procurementTimer !== null) {
    clearInterval(procurementTimer);
    procurementTimer = null;
  }
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  log.info('Procurement worker stopped');
}
