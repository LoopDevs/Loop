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
 */
interface CachedPrice {
  /** Minor units per XLM, keyed by currency. 1 XLM = (n * 10^-2) units. */
  minorPerXlm: Partial<Record<'USD' | 'GBP' | 'EUR', number>>;
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
  // Convert major-unit USD to cents: 1 USDish × 100 = cents.
  // Pricing APIs typically return 6+ decimals; we round to cent so
  // stroopsPerCent math stays integer.
  const minorPerXlm: CachedPrice['minorPerXlm'] = {
    USD: Math.round(usd * 100),
  };
  if (typeof gbp === 'number') minorPerXlm.GBP = Math.round(gbp * 100);
  if (typeof eur === 'number') minorPerXlm.EUR = Math.round(eur * 100);
  cached = {
    minorPerXlm,
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
  const snap = cached !== null && cached.expiresAt > Date.now() ? cached : await refresh();
  const minor = snap.minorPerXlm[currency];
  if (minor === undefined) {
    throw new Error(`Price feed has no rate for ${currency}`);
  }
  if (minor <= 0) {
    // A zero/negative price on a fiat feed is never real; guards
    // the callsite from a div-by-zero-shaped incident later.
    throw new Error(`Price feed returned non-positive rate for ${currency}: ${minor}`);
  }
  // 1 XLM = `minor` minor units. 1 XLM = 10^7 stroops.
  // So 1 minor unit = 10^7 / minor stroops.
  // Ceiling so the required-stroops math rejects underpayments — a
  // user sending exactly the computed amount always satisfies `>=`.
  return BigInt(Math.ceil(10_000_000 / minor));
}

// ─── Fiat FX (USDC against non-USD orders) ───────────────────────────────────

/**
 * Response shape for Frankfurter's /latest endpoint:
 *   `{ "amount": 1, "base": "USD", "date": "...", "rates": { "GBP": 0.78, ... } }`
 * Other self-hosted FX feeds are expected to match this shape; an
 * adapter shim is the path of least resistance for a different API.
 */
// Fiat FX feed (Frankfurter) + cross-currency conversion helpers
// (`usdcStroopsPerCent`, `convertMinorUnits`,
// `__resetFxFeedForTests`) live in `./price-feed-fx.ts`. Re-exported
// below so the existing import path (`'../payments/price-feed.js'`)
// used by `amount-sufficient.ts`, `loop-handler.ts`, and the test
// suite resolves unchanged.
export { usdcStroopsPerCent, convertMinorUnits, __resetFxFeedForTests } from './price-feed-fx.js';
