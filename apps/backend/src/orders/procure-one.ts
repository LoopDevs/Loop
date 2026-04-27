/**
 * Single-order procurement attempt (ADR 010 / 013 / 015).
 *
 * Lifted out of `./procurement.ts` so the per-order ladder
 * (mark-procuring → rail decision → CTX call → redemption fetch →
 * mark-fulfilled + Discord fanout) lives separately from the
 * batch driver `runProcurementTick`.
 *
 * Returns the outcome label so the caller can increment its batch
 * counter without inspecting the order row.
 */
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { markOrderProcuring, markOrderFulfilled, markOrderFailed } from './transitions.js';
import type { Order } from './repo.js';
import { operatorFetch, OperatorPoolUnavailableError } from '../ctx/operator-pool.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCashbackCredited, notifyUsdcBelowFloor } from '../discord.js';
import { getMerchants } from '../merchants/sync.js';
import { fetchRedemption } from './procurement-redemption.js';
import {
  pickProcurementAsset,
  readUsdcBalanceSafely,
  shouldAlertBelowFloor,
} from './procurement-asset-picker.js';

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
 * Attempts procurement on a single order. Returns the outcome label
 * so callers can increment their batch counters.
 */
export async function procureOne(order: Order): Promise<'fulfilled' | 'failed' | 'skipped'> {
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
