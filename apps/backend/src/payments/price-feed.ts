/**
 * XLM price oracle (ADR 010 follow-up).
 *
 * Fetches the current USD / GBP / EUR price of one XLM from a public
 * price feed, caches it for 60s, and exposes a `stroopsPerCent(currency)`
 * helper the payment watcher uses to size-check an incoming XLM
 * payment against an order's pinned minor-unit face value.
 *
 * Defaults to CoinGecko's public `/simple/price` endpoint; operators
 * override with `LOOP_XLM_PRICE_FEED_URL` for a self-hosted or
 * commercial feed. The URL must return
 *   { stellar: { usd: number, gbp: number, eur: number } }
 * which matches CoinGecko's shape — adapters for other APIs can be
 * a self-hosted shim.
 *
 * Why the cache TTL is 60s: the watcher ticks every 10s; polling a
 * rate API on every tick would gate the whole loop on external
 * availability and rate-limit us. 60s of staleness on a price is
 * bounded slippage — a user paying mid-price-move either slightly
 * overpays or the watcher rejects and they retry.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'price-feed' });

const CoinGeckoResponse = z.object({
  stellar: z.object({
    usd: z.number(),
    gbp: z.number().optional(),
    eur: z.number().optional(),
  }),
});

/**
 * Cache stamps in wall-clock ms. Single-entry cache: one URL feeds
 * all three currencies, so we don't need per-currency bookkeeping.
 *
 * A4-106: store the rate as MICRO-CENTS per XLM (cents × 10^6) so
 * the size-check math keeps sub-cent precision through the
 * conversion. Earlier `Math.round(usd * 100)` rounded straight to
 * cents, opening a ~5% underpayment window when the floor-to-cent
 * direction favoured the user. Multiplying by 1e8 instead lets us
 * compute `ceil(chargeMinor × 10^13 / microCentsPerXlm)` with one
 * deterministic rounding at the boundary.
 */
interface CachedPrice {
  /**
   * Micro-cents (cents × 10^6) per 1 XLM, keyed by currency.
   * 1 XLM = (microCentsPerXlm × 10^-8) major units.
   */
  microCentsPerXlm: Partial<Record<'USD' | 'GBP' | 'EUR', number>>;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
let cached: CachedPrice | null = null;

/** Test seam — forgets the price cache so the next call re-fetches. */
export function __resetPriceFeedForTests(): void {
  cached = null;
}

function feedUrl(): string {
  const override = process.env['LOOP_XLM_PRICE_FEED_URL'];
  if (typeof override === 'string' && override.length > 0) return override;
  return 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd,gbp,eur';
}

async function refresh(): Promise<CachedPrice> {
  const url = feedUrl();
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Price feed ${res.status} from ${url}`);
  }
  const raw = await res.json();
  const parsed = CoinGeckoResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, url }, 'Price feed schema drift');
    throw new Error('Price feed schema drift');
  }
  const { usd, gbp, eur } = parsed.data.stellar;
  // A4-106: scale to micro-cents (cents × 10^6) so the size-check
  // math keeps the upstream feed's typical 6+ decimal precision.
  // 1 USD = 100 cents = 100_000_000 micro-cents.
  const microCentsPerXlm: CachedPrice['microCentsPerXlm'] = {
    USD: Math.round(usd * 100_000_000),
  };
  if (typeof gbp === 'number') microCentsPerXlm.GBP = Math.round(gbp * 100_000_000);
  if (typeof eur === 'number') microCentsPerXlm.EUR = Math.round(eur * 100_000_000);
  cached = {
    microCentsPerXlm,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return cached;
}

/**
 * Returns how many Stellar stroops (native XLM, 7 decimals) equal
 * one minor unit of `currency`. Watcher usage: required stroops =
 * `order.faceValueMinor * stroopsPerCent(order.currency)`.
 *
 * Throws if the feed can't be reached and the cache is empty (no
 * fallback to stale) — a live price is load-bearing for size checks.
 * The payment watcher's tick-level try/catch catches the throw and
 * logs; the order stays `pending_payment` and the next tick tries
 * again.
 */
export async function stroopsPerCent(currency: 'USD' | 'GBP' | 'EUR'): Promise<bigint> {
  // A4-106: kept as a low-fidelity preview helper for callers that
  // genuinely just want a per-cent quote (e.g. dev logging).
  // Production size-check math goes through
  // `requiredStroopsForCharge` so the per-charge ceil avoids
  // rounding-down 4–5% underpayments at the cent boundary.
  const microCents = await microCentsPerXlmFor(currency);
  // 1 XLM = `microCents` × 10^-6 cents = 10^7 stroops.
  // 1 cent = (10^7 / microCents) × 10^6 stroops = 10^13 / microCents stroops.
  return BigInt(Math.ceil(10_000_000_000_000 / microCents));
}

async function microCentsPerXlmFor(currency: 'USD' | 'GBP' | 'EUR'): Promise<number> {
  const snap = cached !== null && cached.expiresAt > Date.now() ? cached : await refresh();
  const microCents = snap.microCentsPerXlm[currency];
  if (microCents === undefined) {
    throw new Error(`Price feed has no rate for ${currency}`);
  }
  if (microCents <= 0) {
    throw new Error(`Price feed returned non-positive rate for ${currency}: ${microCents}`);
  }
  return microCents;
}

/**
 * A4-106: precise required-stroops for an XLM payment of
 * `chargeMinor` (cents) against the live oracle. Performs ONE
 * ceiling at the end so a user trying to under-pay can't ride a
 * floor-to-cent rounding window. Use in preference to
 * `stroopsPerCent` × `chargeMinor`.
 *
 *   1 XLM = microCents × 10^-6 cents = 10^7 stroops
 *   ⇒ 1 cent  = 10^13 / microCents stroops
 *   ⇒ N cents = ceil(N × 10^13 / microCents) stroops
 */
export async function requiredStroopsForCharge(
  chargeMinor: bigint,
  currency: 'USD' | 'GBP' | 'EUR',
): Promise<bigint> {
  const microCents = await microCentsPerXlmFor(currency);
  // BigInt division floors; `(num + denom - 1) / denom` is the
  // standard ceiling pattern.
  const num = chargeMinor * 10_000_000_000_000n;
  const denom = BigInt(microCents);
  return (num + denom - 1n) / denom;
}

// Fiat FX feed (Frankfurter) + cross-currency conversion helpers
// (`usdcStroopsPerCent`, `convertMinorUnits`,
// `__resetFxFeedForTests`) live in `./price-feed-fx.ts`. Re-exported
// below so the existing import path (`'../payments/price-feed.js'`)
// used by `amount-sufficient.ts`, `loop-handler.ts`, and the test
// suite resolves unchanged.
export { usdcStroopsPerCent, convertMinorUnits, __resetFxFeedForTests } from './price-feed-fx.js';
