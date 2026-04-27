/**
 * Fiat FX feed (Frankfurter) + cross-currency conversion helpers
 * (ADR 015).
 *
 * Lifted out of `apps/backend/src/payments/price-feed.ts` so the
 * fiat-FX surface lives in its own focused module separate from
 * the XLM/CoinGecko surface in the parent file. The two feeds
 * have nothing in common beyond the 60s cache pattern — they hit
 * different upstreams, parse different shapes, and serve
 * different consumers. Co-locating them (as before) made the
 * file long for no reader benefit.
 *
 * This module owns:
 *   - `usdcStroopsPerCent(currency)` — USDC stroops per fiat
 *     minor unit (1 USDC = 1 USD; GBP/EUR scaled via Frankfurter).
 *   - `convertMinorUnits(amount, from, to)` — fiat → fiat minor-
 *     unit conversion (USD-anchored, two-hop GBP↔EUR via USD,
 *     ceiling rounding so the user's charge always covers the
 *     catalog price after sub-cent rounding).
 *   - `__resetFxFeedForTests()` — wipes the FX cache.
 *
 * Re-exported from `price-feed.ts` so the existing import path
 * (`'../payments/price-feed.js'`) used by `amount-sufficient.ts`,
 * `loop-handler.ts`, and the test suite resolves unchanged.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'price-feed-fx' });

/**
 * Frankfurter response shape — `{ base: 'USD', rates: { GBP, EUR } }`.
 * We pin the base on parse so a misconfigured feed (different base)
 * loud-fails rather than silently miscomputing rates.
 */
const FxFeedResponse = z.object({
  base: z.string(),
  rates: z.record(z.string(), z.number()),
});

interface CachedFx {
  /** How many `{code}` minor units per 100 USD minor units (cents). */
  minorPerUsdDollar: Partial<Record<'GBP' | 'EUR', number>>;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

let cachedFx: CachedFx | null = null;

/** Test seam — forgets the fiat FX cache. */
export function __resetFxFeedForTests(): void {
  cachedFx = null;
}

function fxFeedUrl(): string {
  const override = process.env['LOOP_FX_FEED_URL'];
  if (typeof override === 'string' && override.length > 0) return override;
  return 'https://api.frankfurter.app/latest?from=USD&to=GBP,EUR';
}

async function refreshFx(): Promise<CachedFx> {
  const url = fxFeedUrl();
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`FX feed ${res.status} from ${url}`);
  }
  const raw = await res.json();
  const parsed = FxFeedResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, url }, 'FX feed schema drift');
    throw new Error('FX feed schema drift');
  }
  if (parsed.data.base !== 'USD') {
    throw new Error(`FX feed base is ${parsed.data.base}, expected USD`);
  }
  const rates = parsed.data.rates;
  const minorPerUsdDollar: CachedFx['minorPerUsdDollar'] = {};
  if (typeof rates['GBP'] === 'number') minorPerUsdDollar.GBP = rates['GBP'];
  if (typeof rates['EUR'] === 'number') minorPerUsdDollar.EUR = rates['EUR'];
  cachedFx = {
    minorPerUsdDollar,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return cachedFx;
}

/**
 * Returns how many USDC stroops (7 decimals, 1 USDC = 1 USD) equal
 * one minor unit of `currency`. For USD this is the static
 * `USDC_STROOPS_PER_CENT = 100_000`. For GBP / EUR it consults the
 * fiat FX feed and scales.
 *
 * Example: USD/GBP rate 0.78 means £1 = $1.282..., so £1 (100p) =
 * $1.282 = ~128 USDC cents = 12_820_512 stroops, giving ~128_205
 * stroops per pence. The watcher multiplies this by the order's
 * `face_value_minor` to compute the required stroops.
 */
export async function usdcStroopsPerCent(currency: 'USD' | 'GBP' | 'EUR'): Promise<bigint> {
  if (currency === 'USD') return 100_000n;
  const usdPerTarget = await usdRateFor(currency);
  // 1 USD = `usdPerTarget` target units (e.g. 0.78 GBP).
  // → 1 target unit = 1 / usdPerTarget USD.
  // → 1 target minor = (1 / usdPerTarget) / 100 USD = 1 / (usdPerTarget × 100) USD.
  // USDC is 1:1 with USD at 7 decimals:
  //   1 USD = 10^7 stroops → target-minor → stroops is
  //   10^7 / (usdPerTarget × 100) = 10^5 / usdPerTarget stroops-per-target-minor.
  // Ceiling so exact payments satisfy `>=`.
  return BigInt(Math.ceil(100_000 / usdPerTarget));
}

/**
 * Reads the USD→`target` rate, ensuring the cache is fresh. Exposed
 * so convertMinorUnits can share the same cache as the stroops-per-
 * cent math — one upstream request feeds every FX consumer in the
 * process.
 */
async function usdRateFor(target: 'GBP' | 'EUR'): Promise<number> {
  const snap = cachedFx !== null && cachedFx.expiresAt > Date.now() ? cachedFx : await refreshFx();
  const rate = snap.minorPerUsdDollar[target];
  if (rate === undefined) {
    throw new Error(`FX feed has no rate for USD→${target}`);
  }
  if (rate <= 0) {
    throw new Error(`FX feed returned non-positive rate for ${target}: ${rate}`);
  }
  return rate;
}

/**
 * Converts a minor-unit amount between two fiat currencies (ADR 015).
 *
 * The catalog → home-currency conversion at order creation is the
 * primary user: a user with `home_currency = GBP` buying a $50 USD
 * gift card has the charge pinned at `convertMinorUnits(5000, 'USD',
 * 'GBP')` pence.
 *
 * Uses Frankfurter's USD-anchored rate table (same cache as the
 * USDC stroops-per-cent math), so GBP↔EUR is a two-hop via USD.
 * Rounds **up** (ceiling) so the user's charge covers the catalog
 * price after sub-cent rounding — Loop absorbs the one-minor-unit
 * rounding in the user's favour on the procurement side.
 *
 * Throws on an unreachable / schema-drifted feed (no stale fallback
 * — a live rate is load-bearing for anything price-sensitive). The
 * caller's try/catch decides whether to 503 or queue.
 */
export async function convertMinorUnits(
  amount: bigint,
  from: 'USD' | 'GBP' | 'EUR',
  to: 'USD' | 'GBP' | 'EUR',
): Promise<bigint> {
  if (amount === 0n) return 0n;
  if (amount < 0n) {
    throw new Error(`convertMinorUnits: negative amount not supported (${amount})`);
  }
  if (from === to) return amount;
  // Work in rationals with a fixed 1e9 scale to keep enough precision
  // for any plausible Frankfurter rate (4-5 significant digits typical)
  // without floating through JS numbers for the arithmetic.
  const SCALE = 1_000_000_000n;
  let amountAsUsdScaled: bigint;
  if (from === 'USD') {
    amountAsUsdScaled = amount * SCALE;
  } else {
    // amount in `from` minor → amount in USD minor = amount / rate.
    const rate = await usdRateFor(from);
    // rate is a JS number like 0.7831; scale to integer math with 1e9.
    const rateScaled = BigInt(Math.round(rate * Number(SCALE)));
    if (rateScaled === 0n) {
      throw new Error(`convertMinorUnits: rate USD→${from} rounded to zero (${rate})`);
    }
    // amount / rate = amount * SCALE / rateScaled, but we want USD minor
    // pre-SCALE (so the USD→to branch below can reapply SCALE cleanly).
    // So: amountAsUsdScaled = (amount * SCALE * SCALE) / rateScaled.
    amountAsUsdScaled = (amount * SCALE * SCALE) / rateScaled;
  }
  if (to === 'USD') {
    // Ceiling divide by SCALE.
    return (amountAsUsdScaled + SCALE - 1n) / SCALE;
  }
  const rate = await usdRateFor(to);
  const rateScaled = BigInt(Math.round(rate * Number(SCALE)));
  // usd * rate → target minor. amountAsUsdScaled is already × SCALE, so
  // target = amountAsUsdScaled × rateScaled / (SCALE × SCALE). Ceiling.
  const numerator = amountAsUsdScaled * rateScaled;
  const denominator = SCALE * SCALE;
  return (numerator + denominator - 1n) / denominator;
}
