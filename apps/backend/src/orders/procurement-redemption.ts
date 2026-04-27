/**
 * CTX gift-card-detail fetch + parsing — the redemption-side of
 * procurement (ADR 010 / ADR 015 follow-up).
 *
 * Lifted out of `apps/backend/src/orders/procurement.ts`. The
 * procurement worker calls `fetchRedemption(ctxOrderId)` once per
 * successful order to pull the user-facing redeem code / PIN /
 * URL — CTX has been observed to use both `redeemCode` / `code`
 * spellings in the wild depending on endpoint version, so the
 * parser collapses them into our internal shape.
 *
 * This is the only place in the backend that decodes a CTX
 * `/gift-cards/:id` response. Pulling it out gives the parser a
 * focused home + makes the procurement worker file shorter and
 * easier to read.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import { operatorFetch } from '../ctx/operator-pool.js';
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
  return {
    code: parsed.data.redeemCode ?? parsed.data.code ?? null,
    pin: parsed.data.redeemPin ?? parsed.data.pin ?? null,
    url: parsed.data.redeemUrl ?? parsed.data.url ?? null,
  };
}
