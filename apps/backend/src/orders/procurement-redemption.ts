/**
 * CTX gift-card-detail fetch + parsing — the redemption-side of
 * procurement (ADR 010 / ADR 015 follow-up).
 *
 * Lifted out of `apps/backend/src/orders/procurement.ts`. The
 * procurement worker calls `waitForRedemption(ctxOrderId)` per
 * successful order to wait out CTX's issuance latency and pull the
 * user-facing redeem code / PIN / URL — CTX has been observed to
 * use both `redeemCode` / `code` spellings in the wild depending on
 * endpoint version, so the parser collapses them into our internal
 * shape.
 *
 * This is the only place in the backend that decodes a CTX
 * `/gift-cards/:id` response. Pulling it out gives the parser a
 * focused home + makes the procurement worker file shorter and
 * easier to read.
 *
 * Two consumption shapes co-exist:
 *
 *   - `fetchRedemption` (legacy, exported for any one-shot caller):
 *     a single GET. Returns whatever the response holds at that
 *     instant — often null fields when CTX is still issuing.
 *   - `waitForRedemption` (used by the procurement worker): subscribes
 *     to CTX's SSE stream first, waits for terminal `fulfilled`,
 *     then runs one authoritative `fetchRedemption`. Falls back to
 *     1-second polling if the stream errors. 5-minute budget by
 *     default. Ported from VCC's `pollCtxForClaimUrl` pattern.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import { operatorFetch, pickOperatorCredentials } from '../ctx/operator-pool.js';
import { streamGiftCardStatus } from '../ctx/stream.js';
import { upstreamUrl } from '../upstream.js';

const log = logger.child({ area: 'procurement-redemption' });

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
export async function fetchRedemption(ctxOrderId: string): Promise<{
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
  const out = {
    code: parsed.data.redeemCode ?? parsed.data.code ?? null,
    pin: parsed.data.redeemPin ?? parsed.data.pin ?? null,
    url: parsed.data.redeemUrl ?? parsed.data.url ?? null,
  };
  // Diagnostic: CTX has been returning 200 with all redemption fields
  // missing across long polling windows for operator-account orders.
  // When that happens, log the raw response keys + a truncated body
  // so ops can tell `wrong field name` from `genuinely empty`. We
  // only log when EVERY field is null — once any code/pin/url is
  // populated the codes are PII and must not land in logs.
  if (out.code === null && out.pin === null && out.url === null) {
    const keys = raw !== null && typeof raw === 'object' ? Object.keys(raw) : [];
    const bodyPreview = JSON.stringify(raw).slice(0, 500);
    log.info(
      { ctxOrderId, keys, bodyPreview },
      'CTX gift-card detail returned no redemption fields — capturing shape for diagnosis',
    );
  }
  return out;
}

/**
 * Stream-first redemption wait. Mirrors VCC's `pollCtxForClaimUrl`
 * (`vcc/api/src/ctx/client.js` + `vcc/api/src/fulfillment.js`):
 *
 *   1. Subscribe to CTX's SSE stream
 *      (`GET /gift-cards/:id?stream=true&token=...`).
 *   2. On terminal `fulfilled`/`complete`, do one authoritative
 *      `fetchRedemption` — SSE frames don't always carry the
 *      redemption fields, so this is the canonical read.
 *   3. If the stream throws a benign transient error (network blip,
 *      timeout, envoy hiccup), fall back to polling `fetchRedemption`
 *      every second for the remaining budget.
 *   4. Bail with the most-recent redemption payload (which may still
 *      be empty) when the total budget is exhausted — the order will
 *      transition to `fulfilled` either way; redemption fields can
 *      be backfilled later by a sweep if needed.
 *
 * Terminal CTX-side rejections (`rejected`/`failed`/`error` from the
 * stream) propagate as exceptions — the procurement worker catches
 * those and transitions the order to `failed`.
 */
export interface WaitForRedemptionOptions {
  /** Total wall-clock budget across stream + polling fallback (ms). Default 5 min. */
  totalTimeoutMs?: number;
  /** Polling interval after a stream error (ms). Default 1 s. */
  pollIntervalMs?: number;
}

// Test seam: the procurement tick test suite drives many orders
// through `waitForRedemption` synchronously. Reading the defaults
// from env at call time lets tests collapse the 5-min / 1-s timing
// into a few ms without binding test concerns into the function
// signature. Production never sets these; the 5-min budget + 1-s
// polling stays the operator-facing default.
function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export async function waitForRedemption(
  ctxOrderId: string,
  opts: WaitForRedemptionOptions = {},
): Promise<{
  code: string | null;
  pin: string | null;
  url: string | null;
}> {
  const totalTimeoutMs =
    opts.totalTimeoutMs ?? numericEnv('LOOP_REDEMPTION_TOTAL_TIMEOUT_MS', 5 * 60 * 1000);
  const pollIntervalMs =
    opts.pollIntervalMs ?? numericEnv('LOOP_REDEMPTION_POLL_INTERVAL_MS', 1000);
  const deadline = Date.now() + totalTimeoutMs;

  const creds = pickOperatorCredentials();
  if (creds === null) {
    // No healthy operators — fall straight through to polling, which
    // uses `operatorFetch` and has its own pool-exhausted handling.
    log.warn(
      { ctxOrderId },
      'No healthy operator for SSE stream — falling back to polling immediately',
    );
  } else {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
      try {
        await streamGiftCardStatus(ctxOrderId, {
          bearer: creds.bearer,
          clientId: creds.clientId,
          signal: controller.signal,
          onUpdate: (frame) => {
            const status =
              typeof frame.fulfilmentStatus === 'string'
                ? frame.fulfilmentStatus
                : typeof frame.status === 'string'
                  ? frame.status
                  : 'unknown';
            log.debug({ ctxOrderId, status }, 'CTX SSE frame');
          },
        });
      } finally {
        clearTimeout(timer);
      }
      // Stream confirmed terminal status. Do the canonical read.
      return await fetchRedemption(ctxOrderId);
    } catch (err) {
      // CTX-side rejections must propagate so the procurement worker
      // transitions the order to `failed`. Stream-transport errors
      // (network/timeout/etc.) fall through to the polling loop.
      const msg = err instanceof Error ? err.message : String(err);
      if (/^CTX order .* (rejected|failed|error)/.test(msg)) {
        throw err;
      }
      log.warn({ ctxOrderId, err: msg }, 'CTX SSE stream errored — falling back to polling');
    }
  }

  // Polling fallback. Re-fetches `/gift-cards/:id` every
  // `pollIntervalMs` until we see a non-null redemption field or the
  // budget runs out. We deliberately return whatever payload we have
  // when the budget exhausts — the procurement worker will still
  // mark the order `fulfilled` and a follow-up sweep can backfill.
  let last: { code: string | null; pin: string | null; url: string | null } = {
    code: null,
    pin: null,
    url: null,
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      last = await fetchRedemption(ctxOrderId);
      if (last.code !== null || last.pin !== null || last.url !== null) {
        return last;
      }
    } catch (err) {
      log.warn(
        { ctxOrderId, err: err instanceof Error ? err.message : String(err) },
        'Polling fetchRedemption tick failed — continuing',
      );
    }
  }
  log.warn(
    { ctxOrderId },
    'waitForRedemption budget exhausted with no redemption payload — persisting nulls',
  );
  return last;
}
