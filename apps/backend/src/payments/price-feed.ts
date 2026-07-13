/**
 * XLM price oracle (ADR 010 follow-up).
 *
 * Fetches the current USD / GBP / EUR price of one XLM from a price
 * feed, caches it for 60s, and exposes a `stroopsPerCent(currency)`
 * helper the payment watcher uses to size-check an incoming XLM
 * payment against an order's pinned minor-unit face value.
 *
 * Two adapter modes (selected automatically by URL host):
 *
 *   1. **CTX rates** (default, 2026-05-05): three parallel fetches to
 *      `https://rates.ctx.com/rates?source=ctx&symbol={xlmusd,xlmgbp,xlmeur}`,
 *      each returning a single-element array of
 *      `{ baseCurrency, price, quoteCurrency, retrieved, source, symbol }`.
 *      A pair returning empty / 404 / network error is tolerated:
 *      that currency simply won't be available in the snapshot
 *      (watcher rejects orders in that currency until the next tick).
 *      USD must succeed — it's the floor currency.
 *
 *   2. **CoinGecko** (operator override via `LOOP_XLM_PRICE_FEED_URL`):
 *      single fetch returning `{ stellar: { usd, gbp?, eur? } }`. Used
 *      when an operator points the env var at CoinGecko, a self-hosted
 *      shim, or a commercial feed mirroring CoinGecko's shape. Selected
 *      whenever the override env var is set, regardless of host —
 *      operators who want CTX shape can leave the env var unset.
 *
 * Why the cache TTL is 60s: the watcher ticks every 10s; polling a
 * rate API on every tick would gate the whole loop on external
 * availability and rate-limit us. 60s of staleness on a price is
 * bounded slippage — a user paying mid-price-move either slightly
 * overpays or the watcher rejects and they retry.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import { validateRateJump } from './rate-sanity.js';

const log = logger.child({ area: 'price-feed' });

/**
 * CF2-06 (2026-06-30 cold audit): see `rate-sanity.ts` for the shared
 * mechanism. XLM is a genuinely volatile asset, so this feed's bound is
 * wide enough to tolerate real market moves — a >50% move between two
 * 60s-TTL refreshes is still implausible for a liquid asset and far
 * more likely to be a bad feed response than a real one.
 */
const MAX_RATE_JUMP_RATIO = 0.5;

const CoinGeckoResponse = z.object({
  stellar: z.object({
    usd: z.number(),
    gbp: z.number().optional(),
    eur: z.number().optional(),
  }),
});

/**
 * CTX rates response shape (verified 2026-05-05 against
 * `https://rates.ctx.com/rates?source=ctx&symbol=xlmusd`):
 *
 *   [
 *     {
 *       "baseCurrency": "XLM",
 *       "price": "0.1610",
 *       "quoteCurrency": "USD",
 *       "retrieved": "2026-05-05T22:08:31.914725653Z",
 *       "source": "ctx-average",
 *       "symbol": "XLMUSD"
 *     }
 *   ]
 *
 * `price` is a decimal string (1 baseCurrency = `price` quoteCurrency).
 * The array is single-element per query as far as we've observed; we
 * defensively take the first element matching the requested symbol.
 */
const CtxRateRecord = z.object({
  baseCurrency: z.string(),
  price: z.string(),
  quoteCurrency: z.string(),
  retrieved: z.string(),
  source: z.string(),
  symbol: z.string(),
});
const CtxRatesResponse = z.array(CtxRateRecord);

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

/**
 * Selects the active feed source. Operator override via
 * `LOOP_XLM_PRICE_FEED_URL` switches to the CoinGecko-shape adapter
 * (single fetch). Unset → CTX rates adapter (three parallel fetches,
 * one per currency).
 */
function feedSource(): { kind: 'ctx' } | { kind: 'coingecko'; url: string } {
  const override = process.env['LOOP_XLM_PRICE_FEED_URL'];
  if (typeof override === 'string' && override.length > 0) {
    return { kind: 'coingecko', url: override };
  }
  return { kind: 'ctx' };
}

const CTX_RATES_DEFAULT_BASE = 'https://rates.ctx.com/rates';

/**
 * BK-ctxrates: the CTX rates base URL was a bare hardcoded constant with
 * no override — the only feed env var (`LOOP_XLM_PRICE_FEED_URL`)
 * switches to the *CoinGecko-shape* adapter, so an operator who wants to
 * keep the CTX shape but repoint the host (CTX moves the endpoint, or
 * the checked-in default goes stale) had no lever short of a code
 * change. `LOOP_XLM_CTX_RATES_URL` is that lever: unset → the historical
 * default (behaviour unchanged); set → used as the CTX base. It is
 * validated here at the call site (this feed URL isn't in the zod schema
 * the way `LOOP_XLM_PRICE_FEED_URL` is, so a malformed value must fail
 * loudly on use rather than silently degrade to a broken fetch URL).
 */
function ctxRatesBaseUrl(): string {
  const override = process.env['LOOP_XLM_CTX_RATES_URL'];
  if (override === undefined || override.trim().length === 0) {
    return CTX_RATES_DEFAULT_BASE;
  }
  const trimmed = override.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`LOOP_XLM_CTX_RATES_URL is not a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `LOOP_XLM_CTX_RATES_URL must be an http(s) URL, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  return trimmed;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Price feed ${res.status} from ${url}`);
  }
  return res.json();
}

/**
 * Fetches a single XLM/<quote> rate from CTX rates. Returns the
 * decimal price as a number (1 XLM = `price` quote-currency major
 * units). Returns null when the feed has no data for that pair —
 * caller treats this as "currency unavailable in this snapshot."
 */
async function fetchCtxRate(quote: 'USD' | 'GBP' | 'EUR'): Promise<number | null> {
  const symbol = `xlm${quote.toLowerCase()}`;
  const url = `${ctxRatesBaseUrl()}?source=ctx&symbol=${symbol}`;
  let raw: unknown;
  try {
    raw = await fetchJson(url);
  } catch (err) {
    log.warn({ err, quote, url }, 'CTX rates fetch failed for one pair');
    return null;
  }
  const parsed = CtxRatesResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, url, quote }, 'CTX rates schema drift');
    // USD failure becomes a hard error in the caller; GBP/EUR drift
    // is caller-tolerated, so return null and let it surface there.
    return null;
  }
  // Defensively pick the record matching the requested symbol —
  // future-proofs against the API ever returning a multi-symbol response.
  const record = parsed.data.find((r) => r.symbol.toUpperCase() === `XLM${quote}`);
  if (record === undefined) {
    log.warn(
      { url, quote, returned: parsed.data.map((r) => r.symbol) },
      'CTX rates response missing requested symbol',
    );
    return null;
  }
  const price = Number(record.price);
  if (!Number.isFinite(price) || price <= 0) {
    log.error(
      { url, quote, price: record.price },
      'CTX rates returned non-numeric or non-positive price',
    );
    return null;
  }
  return price;
}

async function refreshCtx(): Promise<CachedPrice> {
  // Three parallel fetches — the API is per-symbol, but this still
  // adds up to ~one round-trip latency since they fire concurrently.
  const [usd, gbp, eur] = await Promise.all([
    fetchCtxRate('USD'),
    fetchCtxRate('GBP'),
    fetchCtxRate('EUR'),
  ]);
  if (usd === null) {
    // USD is the floor currency — without it the feed is effectively
    // dead. Throw so the watcher tick treats this as a feed outage and
    // the caller sees a 503 at order create time.
    throw new Error('CTX rates: USD pair unavailable');
  }
  // CF2-06: capture the pre-refresh cache to validate each currency's
  // new rate against its own last known-good value before accepting it.
  const previous = cached;
  // Scale to micro-cents (cents × 10^6) per A4-106 precision rationale.
  // `price` is major-unit per XLM (e.g. 0.1610 USD per XLM), so
  // microCents per XLM = price × 100 cents/major × 10^6 = price × 1e8.
  const usdMicroCents = Math.round(usd * 100_000_000);
  validateRateJump({
    currency: 'USD',
    feed: 'xlm',
    previousValue: previous?.microCentsPerXlm.USD,
    newValue: usdMicroCents,
    maxRatio: MAX_RATE_JUMP_RATIO,
  });
  const microCentsPerXlm: CachedPrice['microCentsPerXlm'] = { USD: usdMicroCents };
  if (gbp !== null) {
    const gbpMicroCents = Math.round(gbp * 100_000_000);
    validateRateJump({
      currency: 'GBP',
      feed: 'xlm',
      previousValue: previous?.microCentsPerXlm.GBP,
      newValue: gbpMicroCents,
      maxRatio: MAX_RATE_JUMP_RATIO,
    });
    microCentsPerXlm.GBP = gbpMicroCents;
  }
  if (eur !== null) {
    const eurMicroCents = Math.round(eur * 100_000_000);
    validateRateJump({
      currency: 'EUR',
      feed: 'xlm',
      previousValue: previous?.microCentsPerXlm.EUR,
      newValue: eurMicroCents,
      maxRatio: MAX_RATE_JUMP_RATIO,
    });
    microCentsPerXlm.EUR = eurMicroCents;
  }
  cached = { microCentsPerXlm, expiresAt: Date.now() + CACHE_TTL_MS };
  return cached;
}

async function refreshCoinGecko(url: string): Promise<CachedPrice> {
  const raw = await fetchJson(url);
  const parsed = CoinGeckoResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, url }, 'CoinGecko price feed schema drift');
    throw new Error('Price feed schema drift');
  }
  const { usd, gbp, eur } = parsed.data.stellar;
  // CF2-06: same sanity-bound validation as the CTX adapter above.
  const previous = cached;
  const usdMicroCents = Math.round(usd * 100_000_000);
  validateRateJump({
    currency: 'USD',
    feed: 'xlm',
    previousValue: previous?.microCentsPerXlm.USD,
    newValue: usdMicroCents,
    maxRatio: MAX_RATE_JUMP_RATIO,
  });
  const microCentsPerXlm: CachedPrice['microCentsPerXlm'] = { USD: usdMicroCents };
  if (typeof gbp === 'number') {
    const gbpMicroCents = Math.round(gbp * 100_000_000);
    validateRateJump({
      currency: 'GBP',
      feed: 'xlm',
      previousValue: previous?.microCentsPerXlm.GBP,
      newValue: gbpMicroCents,
      maxRatio: MAX_RATE_JUMP_RATIO,
    });
    microCentsPerXlm.GBP = gbpMicroCents;
  }
  if (typeof eur === 'number') {
    const eurMicroCents = Math.round(eur * 100_000_000);
    validateRateJump({
      currency: 'EUR',
      feed: 'xlm',
      previousValue: previous?.microCentsPerXlm.EUR,
      newValue: eurMicroCents,
      maxRatio: MAX_RATE_JUMP_RATIO,
    });
    microCentsPerXlm.EUR = eurMicroCents;
  }
  cached = { microCentsPerXlm, expiresAt: Date.now() + CACHE_TTL_MS };
  return cached;
}

async function refresh(): Promise<CachedPrice> {
  const source = feedSource();
  if (source.kind === 'ctx') return refreshCtx();
  return refreshCoinGecko(source.url);
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
export {
  usdcStroopsPerCent,
  convertMinorUnits,
  CurrencyRateUnavailableError,
  __resetFxFeedForTests,
} from './price-feed-fx.js';
