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
import {
  markOrderProcuring,
  markOrderFulfilled,
  markOrderFailed,
  revertOrderProcuringToPaid,
} from './transitions.js';
import type { Order } from './repo.js';
import {
  operatorFetch,
  OperatorPoolUnavailableError,
  OperatorRateLimitedError,
} from '../ctx/operator-pool.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import {
  notifyCashbackCredited,
  notifyUsdcBelowFloor,
  notifyOrderFailedAfterCtxPaid,
} from '../discord.js';
import {
  applyOrderAutoRefund,
  RefundAlreadyIssuedError,
  RefundOrderInvalidError,
} from '../credits/refunds.js';
import { getMerchants } from '../merchants/sync.js';
import { waitForRedemption } from './procurement-redemption.js';
import { parseSep7PayUri } from './sep7.js';
import { payCtxOrder, PayCtxConfigError, PayCtxReconcileError } from './pay-ctx.js';
import { PayoutSubmitError } from '../payments/payout-submit.js';
import {
  pickProcurementAsset,
  readUsdcBalanceSafely,
  shouldAlertBelowFloor,
} from './procurement-asset-picker.js';

const log = logger.child({ area: 'procurement' });

/**
 * CTX response shape for POST /gift-cards. We pin:
 *   - `id` to persist as `ctx_order_id`.
 *   - `paymentUrls.XLM` — the SEP-7 URI Loop must pay to settle the
 *     order on CTX's side (ADR 010 principal switch). Without this
 *     CTX treats the order as `unpaid` and never issues codes.
 *   - `paymentCryptoAmount` — captured for log/observability; the
 *     authoritative amount lives in the SEP-7 URI itself.
 *
 * `.passthrough()` on `paymentUrls` keeps unknown rail entries
 * (USDC, etc.) around without forcing a schema edit when CTX adds
 * a new one. Required-field validation lives on the consumer side
 * (`parseSep7PayUri`).
 */
const CtxGiftCardResponse = z.object({
  id: z.string().min(1),
  paymentUrls: z.record(z.string(), z.string()).optional(),
  paymentCryptoAmount: z.string().optional(),
});

/**
 * A4-017: bigint-safe minor → major decimal string. Bigints lose
 * precision when coerced through `Number(...)` past 2^53; `1234n`
 * cents must always serialize as `"12.34"`. Pads the fractional
 * part to two digits so `5n` becomes `"0.05"` rather than `"0.5"`.
 */
function formatMinorToMajor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const cents = abs % 100n;
  const dollars = abs / 100n;
  const fractional = cents.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${dollars.toString()}.${fractional}`;
}

/**
 * Attempts procurement on a single order. Returns the outcome label
 * so callers can increment their batch counters.
 */
/**
 * CTX-02 (2026-06-30 cold audit): CF-12 correctly parses CTX's
 * `Retry-After` header but never enforced it — `runProcurementTick`
 * re-queries `state='paid'` orders on the next fixed-interval tick
 * (default ~5s) regardless, so a 429 never actually backed off; it
 * just stopped counting as an order failure while still re-hammering
 * CTX every tick. Rate-limiting is an upstream-wide signal (not
 * per-order), so the gate is process-wide: once any operator 429s,
 * skip picking up ANY order until the parsed `Retry-After` window
 * elapses. `runProcurementTick` checks `ctxBackoffActive()` before
 * even querying for paid orders.
 *
 * Known limitation (tracked in Wave 9 of the remediation plan): this
 * is in-memory, so it's per-Fly-machine, not fleet-wide — on a
 * multi-machine deploy each instance backs off independently. Still a
 * real improvement over never backing off at all, and the per-machine
 * gap is the same shape as every other in-memory limiter flagged
 * elsewhere in this audit round, tracked for the same shared-store fix.
 */
let ctxBackoffUntilMs = 0;

export function ctxBackoffActive(now: number = Date.now()): boolean {
  return now < ctxBackoffUntilMs;
}

/** Test seam: clears the process-wide CTX back-off gate. */
export function __resetCtxBackoffForTests(): void {
  ctxBackoffUntilMs = 0;
}

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
  //
  // CF-14 (x-concurrency-financial X-2) cross-instance safety: this is
  // already a state-guarded claim. `markOrderProcuring` is an atomic
  // `UPDATE ... WHERE state='paid' → 'procuring' RETURNING`, so when
  // the procurement worker runs on two Fly machines at once exactly
  // one machine wins the row (the other gets `null` → `skipped`).
  // Unlike the payout worker there is no shared-sequence-number
  // resource across rows — each CTX wholesale purchase is an
  // independent HTTP call, not a tx against one operator account — so
  // no `SKIP LOCKED` is needed; the worst a duplicate read costs is a
  // wasted candidate scan, never a double-procure or a collision.
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
  //
  // Phase-1 override: in `LOOP_PHASE_1_ONLY` mode we don't have a
  // USDC operator topology yet — the deposit account has no USDC
  // trustline, and CTX's production validator now rejects
  // `cryptoCurrency: "USDC"` outright ("chain prefix invalid"). Pin
  // to XLM here to match the legacy `/api/orders` handler, which
  // hard-codes the same value. Tranche-2 reactivates the picker
  // once the USDC operator account and floor secrets are wired.
  const floorStroops = env.LOOP_STELLAR_USDC_FLOOR_STROOPS ?? null;
  const balanceStroops =
    floorStroops !== null && env.LOOP_STELLAR_DEPOSIT_ADDRESS !== undefined
      ? await readUsdcBalanceSafely(env.LOOP_STELLAR_DEPOSIT_ADDRESS)
      : null;
  const cryptoCurrency: 'USDC' | 'XLM' = env.LOOP_PHASE_1_ONLY
    ? 'XLM'
    : pickProcurementAsset({
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

  // CF-20 (x-flows F1-1, v-orders P2-02): once `payCtxOrder` succeeds
  // Loop has spent operator XLM/USDC settling to CTX, and the user
  // already paid Loop (the order reached `paid` before procureOne ran
  // — `markOrderProcuring` only transitions from `paid`). A later
  // failure (`waitForRedemption` terminal-reject, an unexpected throw)
  // would otherwise leave the user debited with no gift card and only
  // a silent `log.error`. Track the boundary so the terminal-failure
  // path can auto-refund the user + page ops about the operator-side
  // CTX debt. `ctxOrderId` is captured alongside for the alert.
  let ctxPaid = false;
  let ctxOrderId: string | null = null;
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
        // A4-017: bigint-safe major-unit formatting. `Number(faceValueMinor)`
        // would silently lose precision past 2^53 (~$9e13). Even though
        // realistic gift-card values stay under $10k, the boundary is
        // financial; format the bigint directly so the wire string is
        // exact regardless of magnitude.
        fiatAmount: formatMinorToMajor(order.faceValueMinor),
        merchantId: order.merchantId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = scrubUpstreamBody(await res.text());
      log.error({ orderId: order.id, status: res.status, body }, 'CTX procurement returned non-ok');
      const reason = `CTX returned ${res.status}`;
      await markOrderFailed(order.id, reason);
      // CF2-05 (2026-06-30 cold audit): the user already paid Loop before
      // procureOne ran — this pre-payment failure class (this site plus
      // the three below) is the LARGER share of real procurement
      // failures, and previously left the user debited with no gift card
      // and only a silent log.error. No CTX order id available here.
      await autoRefundFailedOrder(order, null, reason, false);
      return 'failed';
    }
    const raw = await res.json();
    const parsed = CtxGiftCardResponse.safeParse(raw);
    if (!parsed.success) {
      log.error(
        { orderId: order.id, issues: parsed.error.issues },
        'CTX procurement response schema drift',
      );
      const reason = 'CTX response schema drift';
      await markOrderFailed(order.id, reason);
      await autoRefundFailedOrder(order, null, reason, false);
      return 'failed';
    }

    // ADR 010 principal switch: Loop pays CTX from the operator
    // wallet using the SEP-7 URI returned in the create-response.
    // Without this hop CTX leaves the order `unpaid` forever and
    // never issues redemption codes — see the four stranded
    // orders pre-2026-05-14 that fulfilled in our ledger but
    // showed `unpaid` on CTX's side.
    const paymentUri = parsed.data.paymentUrls?.[cryptoCurrency];
    if (paymentUri === undefined || paymentUri === '') {
      log.error(
        { orderId: order.id, ctxOrderId: parsed.data.id, cryptoCurrency },
        'CTX procurement response missing paymentUrls entry — cannot pay CTX',
      );
      const reason = `CTX response missing paymentUrls.${cryptoCurrency}`;
      await markOrderFailed(order.id, reason);
      await autoRefundFailedOrder(order, parsed.data.id, reason, false);
      return 'failed';
    }
    const sep7 = parseSep7PayUri(paymentUri);
    if (!sep7.ok) {
      log.error(
        { orderId: order.id, ctxOrderId: parsed.data.id, sep7Error: sep7.error },
        'CTX paymentUrls entry failed SEP-7 parse',
      );
      const reason = `CTX paymentUrls SEP-7 ${sep7.error}`;
      await markOrderFailed(order.id, reason);
      await autoRefundFailedOrder(order, parsed.data.id, reason, false);
      return 'failed';
    }
    try {
      const payRes = await payCtxOrder(sep7.value);
      // CF-20: from here on a failure leaves Loop having paid CTX.
      // Pin the boundary + ctx order id for the auto-refund path.
      ctxPaid = true;
      ctxOrderId = parsed.data.id;
      log.info(
        {
          orderId: order.id,
          ctxOrderId: parsed.data.id,
          ctxPaymentTxHash: payRes.txHash,
          submitted: payRes.submitted,
        },
        payRes.submitted
          ? 'Paid CTX for order'
          : 'CTX payment already on chain (idempotent re-run)',
      );
    } catch (err) {
      // Config error is an ops bug — operator secret missing /
      // invalid. Fail the order so the operator sees it loudly;
      // the underlying env fix is required before any procurement
      // can succeed.
      if (err instanceof PayCtxConfigError) {
        log.error({ orderId: order.id, err: err.message }, 'CTX payment config error');
        await markOrderFailed(order.id, `CTX payment config: ${err.message}`);
        return 'failed';
      }
      // Idempotency match with a mismatched amount/asset (memo collision
      // or tampered URI). Fail the order loudly — neither skipping
      // (CTX unpaid) nor blind re-submit (possible double-pay) is safe;
      // an operator must reconcile. See PayCtxReconcileError.
      if (err instanceof PayCtxReconcileError) {
        log.error({ orderId: order.id, err: err.message }, 'CTX payment reconcile mismatch');
        await markOrderFailed(order.id, `CTX payment reconcile: ${err.message}`);
        return 'failed';
      }
      // CF2-04 (2026-06-30 cold audit): transient_horizon/transient_rebuild
      // are explicitly the retry-safe kinds `payout-submit.ts` documents —
      // Horizon couldn't confirm the tx's fate (network blip, ambiguous
      // response), not "this payment is genuinely bad". Failing the order
      // here loses a real paid order over a transient upstream hiccup.
      // Safe to revert procuring→paid and let the next tick retry (same
      // shape as the CF-12 rate-limit path above): payCtxOrder's own
      // idempotency pre-check (memo+amount+asset-matched Horizon scan,
      // this file's `try` block above) runs before any new submit, so a
      // retry can't double-pay CTX even if the ambiguous attempt actually
      // landed. The existing stuck-procurement sweep (marks `procuring`
      // rows `failed` after 15 min) remains the backstop if retries never
      // resolve — unchanged from before this fix.
      if (err instanceof PayoutSubmitError) {
        const isTransient = err.kind === 'transient_horizon' || err.kind === 'transient_rebuild';
        if (isTransient) {
          await revertOrderProcuringToPaid(order.id);
          log.warn(
            { orderId: order.id, kind: err.kind, resultCodes: err.resultCodes },
            'CTX payment submit hit a transient/ambiguous failure — reverted procuring → paid for retry',
          );
          return 'skipped';
        }
        // Terminal kinds (e.g. underfunded, no-trust, bad-auth): failing
        // fast is correct — a retry would hit the exact same wall.
        log.error(
          { orderId: order.id, kind: err.kind, resultCodes: err.resultCodes },
          'CTX payment submit failed',
        );
        await markOrderFailed(order.id, `CTX payment ${err.kind}`);
        return 'failed';
      }
      throw err;
    }

    // Wait for the redemption payload before flipping to fulfilled
    // so the user's "Ready" screen has the code/PIN ready on first
    // render. `waitForRedemption` subscribes to CTX's SSE stream
    // (terminal `fulfilled`/`complete` arrives in seconds typically),
    // then does one authoritative GET to pull the codes — CTX SSE
    // frames don't carry redemption fields. Falls back to 1s polling
    // on stream transport errors and bails after 5 minutes with
    // whatever payload it has. A `failed`/`rejected`/`error` terminal
    // status from the stream throws and is caught by the outer
    // try/catch below, transitioning the order to `failed`.
    const redemption = await waitForRedemption(parsed.data.id);
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
    // CF-12: a CTX 429 across every reachable operator is transient
    // back-pressure, not an order failure. Revert procuring → paid so
    // a later tick re-picks the order once CTX's rate-limit clears —
    // marking it `failed` here would turn a rate-limit into a
    // self-sustaining hot loop that loses real paid orders. Same
    // revert/defer shape as the pool-unavailable path below.
    if (err instanceof OperatorRateLimitedError) {
      await revertOrderProcuringToPaid(order.id);
      // CTX-02: actually enforce the parsed Retry-After instead of just
      // logging it — see ctxBackoffActive()'s docstring. No header →
      // fall back to a conservative 5s (matches the default tick
      // interval, so at minimum we skip the very next re-pick).
      const backoffMs = err.retryAfterMs ?? 5_000;
      ctxBackoffUntilMs = Date.now() + backoffMs;
      log.warn(
        { orderId: order.id, retryAfterMs: err.retryAfterMs, backoffMs },
        'CTX rate-limited (429) — reverted procuring → paid and gated further procurement ticks until backoff elapses',
      );
      return 'skipped';
    }
    if (err instanceof OperatorPoolUnavailableError) {
      // A4-101: revert state back to `paid` so the next
      // procurement tick re-picks the order. Earlier behaviour
      // left the row in `procuring`, but `runProcurementTick`
      // only selects `state='paid'` rows — so the order sat
      // there until the stuck-sweep marked it `failed`
      // (~15 min later) under what is fundamentally a transient
      // ops-pool outage with no CTX call ever made.
      //
      // CF-13: this path now also fires when every operator's bearer
      // returned 401 (expired). The credential alert has already been
      // sent; reverting keeps the order retryable for when ops
      // restores a bearer, rather than failing real paid orders while
      // a credential is rotated.
      await revertOrderProcuringToPaid(order.id);
      log.warn(
        { orderId: order.id },
        'Operator pool unavailable — reverted procuring → paid for retry',
      );
      return 'skipped';
    }
    const reason = err instanceof Error ? err.message.slice(0, 500) : 'Unknown procurement error';
    log.error({ err, orderId: order.id }, 'Procurement threw unexpectedly');
    await markOrderFailed(order.id, reason);
    // CF-20 / CF2-05 (2026-06-30 cold audit): the user already paid Loop
    // (every order reaches procureOne from `state='paid'`), so ANY
    // unexpected throw here — before or after CTX payment — leaves them
    // debited for a gift card they'll never get. Always refund; `ctxPaid`
    // only changes the alert wording (operator-side CTX debt or not).
    // Before this fix, an unexpected throw pre-payment (e.g. `res.json()`
    // throwing on a non-JSON CTX response, uncaught by the inner
    // try/catch's explicit early-returns) skipped the refund entirely.
    await autoRefundFailedOrder(order, ctxOrderId, reason, ctxPaid);
    return 'failed';
  }
}

/**
 * CF-20 (x-flows F1-1, v-orders P2-02) / CF2-05 (2026-06-30 cold audit):
 * compensate a user whose order failed after they'd already paid Loop.
 * Best-effort + non-throwing — the order is already terminally `failed`;
 * a refund/alert blip must never re-throw out of `procureOne` and abort
 * the batch tick.
 *
 * `ctxPaid` distinguishes the two failure shapes for the Discord alert
 * (CF2-05: the pre-payment case — bad CTX response, schema drift,
 * missing paymentUrls, bad SEP-7 — has no operator-side CTX debt to
 * reconcile, unlike the original CF-20 post-payment case).
 *
 * Refund is idempotent (the partial unique index on the refund row),
 * so a re-pick of the same order (it can't be re-picked once `failed`,
 * but the stuck-sweep / a manual reset are theoretical paths) converges
 * to "already refunded" rather than double-crediting the user.
 */
async function autoRefundFailedOrder(
  order: Order,
  ctxOrderId: string | null,
  reason: string,
  ctxPaid: boolean,
): Promise<void> {
  let refunded = false;
  const reasonPrefix = ctxPaid ? 'order failed after CTX paid' : 'order failed before CTX paid';
  try {
    await applyOrderAutoRefund({
      userId: order.userId,
      currency: order.chargeCurrency,
      amountMinor: order.chargeMinor,
      orderId: order.id,
      reason: `${reasonPrefix}: ${reason}`,
    });
    refunded = true;
    log.warn(
      { orderId: order.id, ctxOrderId, ctxPaid, chargeMinor: order.chargeMinor.toString() },
      `${ctxPaid ? 'CF-20' : 'CF2-05'}: ${reasonPrefix} — auto-refunded the user`,
    );
  } catch (refundErr) {
    if (refundErr instanceof RefundAlreadyIssuedError) {
      // A prior pass already refunded this order. Treat as success —
      // the user is whole; still alert for visibility.
      refunded = true;
      log.warn({ orderId: order.id, ctxOrderId, ctxPaid }, 'order already auto-refunded');
    } else if (refundErr instanceof RefundOrderInvalidError) {
      // Should not happen for a real failed order (it exists, the
      // currency was pinned at creation). Leave refunded=false so the
      // alert escalates and ops investigates.
      log.error(
        { orderId: order.id, ctxOrderId, ctxPaid, reason: refundErr.reason },
        'auto-refund rejected — order/currency invalid; manual refund needed',
      );
    } else {
      log.error(
        { err: refundErr, orderId: order.id, ctxOrderId, ctxPaid },
        'auto-refund threw — user NOT refunded; manual intervention needed',
      );
    }
  }
  // Always page ops — even a successful auto-refund is worth a record,
  // and the ctxPaid branch additionally leaves an operator↔CTX debt open.
  notifyOrderFailedAfterCtxPaid({
    orderId: order.id,
    ctxOrderId,
    userId: order.userId,
    chargeMinor: order.chargeMinor.toString(),
    chargeCurrency: order.chargeCurrency,
    reason,
    refunded,
    ctxPaid,
  });
}
