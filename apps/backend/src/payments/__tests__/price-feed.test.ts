import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  requiredStroopsForCharge,
  stroopsPerCent,
  usdcStroopsPerCent,
  convertMinorUnits,
  CurrencyRateUnavailableError,
  __resetPriceFeedForTests,
  __resetFxFeedForTests,
} from '../price-feed.js';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubFeed(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

// 2026-05-05: default feed is now CTX rates (per-pair fetches at
// `https://rates.ctx.com/rates?source=ctx&symbol=...`). The existing
// XLM tests assert against the CoinGecko `{stellar:{...}}` shape, so
// they set `LOOP_XLM_PRICE_FEED_URL` via beforeEach to exercise the
// CoinGecko adapter path. CTX-shape coverage lives in its own describe
// block at the bottom of the file.
const COINGECKO_OVERRIDE =
  'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd,gbp,eur';

beforeEach(() => {
  __resetPriceFeedForTests();
  __resetFxFeedForTests();
  process.env['LOOP_XLM_PRICE_FEED_URL'] = COINGECKO_OVERRIDE;
  delete process.env['LOOP_FX_FEED_URL'];
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  __resetPriceFeedForTests();
  __resetFxFeedForTests();
  delete process.env['LOOP_XLM_PRICE_FEED_URL'];
  delete process.env['LOOP_FX_FEED_URL'];
});

describe('stroopsPerCent', () => {
  it('returns stroops-per-cent derived from the feed', async () => {
    // 1 XLM = $0.10 → 10 cents → 1e7 stroops / 10 cents = 1e6 stroops/cent.
    fetchSpy = stubFeed({ stellar: { usd: 0.1 } });
    expect(await stroopsPerCent('USD')).toBe(1_000_000n);
  });

  it('returns GBP rate when supplied', async () => {
    // 1 XLM = £0.08 → 8 cents → 1e7 / 8 = 1_250_000 stroops/cent.
    fetchSpy = stubFeed({ stellar: { usd: 0.1, gbp: 0.08 } });
    expect(await stroopsPerCent('GBP')).toBe(1_250_000n);
  });

  it('caches across calls within the TTL window', async () => {
    fetchSpy = stubFeed({ stellar: { usd: 0.1 } });
    await stroopsPerCent('USD');
    await stroopsPerCent('USD');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honours LOOP_XLM_PRICE_FEED_URL override', async () => {
    process.env['LOOP_XLM_PRICE_FEED_URL'] = 'https://custom.example/xlm';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return new Response(JSON.stringify({ stellar: { usd: 0.5 } }), { status: 200 });
    });
    await stroopsPerCent('USD');
    expect(captured[0]!).toBe('https://custom.example/xlm');
  });

  it('throws on non-2xx', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    await expect(stroopsPerCent('USD')).rejects.toThrow(/Price feed 503/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"not":"expected"}', { status: 200 }));
    await expect(stroopsPerCent('USD')).rejects.toThrow(/schema drift/);
  });

  it('throws when the requested currency has no rate', async () => {
    fetchSpy = stubFeed({ stellar: { usd: 0.1 } });
    await expect(stroopsPerCent('GBP')).rejects.toThrow(/no rate for GBP/);
  });

  it('throws on a non-positive rate', async () => {
    fetchSpy = stubFeed({ stellar: { usd: 0 } });
    await expect(stroopsPerCent('USD')).rejects.toThrow(/non-positive rate/);
  });
});

describe('stroopsPerCent — CTX rates adapter', () => {
  // The CTX adapter does per-pair fetches against
  // `https://rates.ctx.com/rates?source=ctx&symbol=xlm{usd,gbp,eur}`.
  // Each returns a single-element array of CtxRateRecord objects.
  // Tests in this describe block clear the override env var so the
  // default CTX path is exercised.
  beforeEach(() => {
    delete process.env['LOOP_XLM_PRICE_FEED_URL'];
  });

  function ctxRecord(base: string, quote: string, price: string): unknown {
    return {
      baseCurrency: base,
      price,
      quoteCurrency: quote,
      retrieved: new Date().toISOString(),
      source: 'ctx-average',
      symbol: `${base}${quote}`,
    };
  }

  function stubCtxFeed(
    rates: Partial<Record<'USD' | 'GBP' | 'EUR', string | null>>,
  ): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      const match = /symbol=xlm(usd|gbp|eur)/i.exec(u);
      if (match === null) {
        return new Response('{"error":"unknown"}', { status: 404 });
      }
      const quote = match[1]!.toUpperCase() as 'USD' | 'GBP' | 'EUR';
      const price = rates[quote];
      if (price === undefined) {
        return new Response('[]', { status: 200 });
      }
      if (price === null) {
        return new Response('feed down', { status: 503 });
      }
      return new Response(JSON.stringify([ctxRecord('XLM', quote, price)]), { status: 200 });
    });
  }

  it('returns stroops-per-cent derived from a CTX-shape USD feed', async () => {
    // 1 XLM = $0.1610 → 16.1 cents → 1e7 stroops / 16.1 cents
    //                = ceil(1e13 / 16_100_000) = 621_119 stroops/cent.
    fetchSpy = stubCtxFeed({ USD: '0.1610', GBP: '0.1280', EUR: '0.1480' });
    expect(await stroopsPerCent('USD')).toBe(621_119n);
  });

  it('returns GBP rate when the GBP pair is supplied', async () => {
    // 1 XLM = £0.1280 → 12.8 cents → 1e7 / 12.8 = 781_250 stroops/cent.
    fetchSpy = stubCtxFeed({ USD: '0.1610', GBP: '0.1280' });
    expect(await stroopsPerCent('GBP')).toBe(781_250n);
  });

  it('falls back gracefully when GBP pair is missing — USD still works', async () => {
    // CTX returns 404 / empty array for GBP; USD must still serve.
    // (This is the production fallback story — partial feed availability
    // shouldn't kill the whole payment system.)
    fetchSpy = stubCtxFeed({ USD: '0.1610' }); // GBP/EUR omitted
    expect(await stroopsPerCent('USD')).toBe(621_119n);
    await expect(stroopsPerCent('GBP')).rejects.toThrow(/no rate for GBP/);
  });

  it('throws when the USD pair is unavailable — USD is the floor', async () => {
    // GBP / EUR can be missing without breaking USD orders, but a
    // missing USD pair means the whole feed is dead.
    fetchSpy = stubCtxFeed({ USD: null, GBP: '0.1280' });
    await expect(stroopsPerCent('USD')).rejects.toThrow(/USD pair unavailable/);
  });

  it('caches across calls within the TTL window', async () => {
    fetchSpy = stubCtxFeed({ USD: '0.1610', GBP: '0.1280', EUR: '0.1480' });
    await stroopsPerCent('USD');
    await stroopsPerCent('GBP');
    await stroopsPerCent('EUR');
    // First call triggers all three parallel fetches; subsequent calls
    // hit the in-process cache. Total fetches: 3 (one per currency).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('targets the rates.ctx.com endpoint with the correct query string', async () => {
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      const u = String(url);
      const match = /symbol=xlm(usd|gbp|eur)/i.exec(u);
      const quote = (match?.[1] ?? 'usd').toUpperCase() as 'USD' | 'GBP' | 'EUR';
      return new Response(JSON.stringify([ctxRecord('XLM', quote, '0.1610')]), { status: 200 });
    });
    await stroopsPerCent('USD');
    expect(captured).toContain('https://rates.ctx.com/rates?source=ctx&symbol=xlmusd');
    expect(captured).toContain('https://rates.ctx.com/rates?source=ctx&symbol=xlmgbp');
    expect(captured).toContain('https://rates.ctx.com/rates?source=ctx&symbol=xlmeur');
  });

  it('throws on schema drift (non-array response)', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }));
    // CTX adapter handles per-pair drift by returning null (logged) and
    // continuing, so partial-failure paths surface as "no rate." A USD
    // schema-drift response → no USD rate → "USD pair unavailable" error.
    await expect(stroopsPerCent('USD')).rejects.toThrow(/USD pair unavailable/);
  });

  it('tolerates a non-numeric price string by treating it as missing', async () => {
    fetchSpy = stubCtxFeed({ USD: '0.1610', GBP: 'NaN' as string });
    expect(await stroopsPerCent('USD')).toBe(621_119n);
    await expect(stroopsPerCent('GBP')).rejects.toThrow(/no rate for GBP/);
  });

  // CF2-06 (2026-06-30 cold audit): the sanity-bound wiring end-to-end —
  // pure-logic coverage for isPlausibleRateJump/validateRateJump lives in
  // rate-sanity.test.ts; these prove refreshCtx actually calls it with a
  // real prior cached value once the 60s TTL has expired.
  describe('CF2-06: rate sanity bound', () => {
    it('accepts a plausible rate change across two refreshes', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = stubCtxFeed({ USD: '0.1610' });
        expect(await stroopsPerCent('USD')).toBe(621_119n);
        // A 20% move is within the 50% XLM bound.
        fetchSpy.mockRestore();
        fetchSpy = stubCtxFeed({ USD: '0.1932' });
        vi.advanceTimersByTime(60_001);
        await expect(stroopsPerCent('USD')).resolves.not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects an implausible rate jump and leaves the prior value unusable (throws instead)', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = stubCtxFeed({ USD: '0.1610' });
        await stroopsPerCent('USD');
        // A >3x jump in one 60s refresh — implausible for a liquid asset.
        fetchSpy.mockRestore();
        fetchSpy = stubCtxFeed({ USD: '0.6000' });
        vi.advanceTimersByTime(60_001);
        await expect(stroopsPerCent('USD')).rejects.toThrow(/exceeds sanity bound/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cold start (first-ever refresh) accepts any rate regardless of magnitude', async () => {
      // No previous cache exists yet — nothing to compare against.
      fetchSpy = stubCtxFeed({ USD: '50.0000' });
      await expect(stroopsPerCent('USD')).resolves.not.toThrow();
    });
  });
});

// BK-ctxrates: the CTX rates base URL is now overridable via
// `LOOP_XLM_CTX_RATES_URL` (default unchanged) and validated at the call
// site, so an operator can repoint the feed when CTX moves the endpoint
// instead of shipping a code change — and a malformed override fails
// loudly rather than silently building a broken fetch URL.
describe('CTX rates base URL override (BK-ctxrates)', () => {
  beforeEach(() => {
    // Exercise the default CTX adapter (no CoinGecko-shape override).
    delete process.env['LOOP_XLM_PRICE_FEED_URL'];
    delete process.env['LOOP_XLM_CTX_RATES_URL'];
    __resetPriceFeedForTests();
  });
  afterEach(() => {
    delete process.env['LOOP_XLM_CTX_RATES_URL'];
  });

  function stubValidCtx(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      const match = /symbol=xlm(usd|gbp|eur)/i.exec(u);
      const quote = (match?.[1] ?? 'usd').toUpperCase();
      return new Response(
        JSON.stringify([
          {
            baseCurrency: 'XLM',
            price: '0.1610',
            quoteCurrency: quote,
            retrieved: new Date().toISOString(),
            source: 'ctx-average',
            symbol: `XLM${quote}`,
          },
        ]),
        { status: 200 },
      );
    });
  }

  it('routes CTX fetches through LOOP_XLM_CTX_RATES_URL when it is set', async () => {
    process.env['LOOP_XLM_CTX_RATES_URL'] = 'https://rates.internal.example/v2/rates';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      const u = String(url);
      const match = /symbol=xlm(usd|gbp|eur)/i.exec(u);
      const quote = (match?.[1] ?? 'usd').toUpperCase();
      return new Response(
        JSON.stringify([
          {
            baseCurrency: 'XLM',
            price: '0.1610',
            quoteCurrency: quote,
            retrieved: new Date().toISOString(),
            source: 'ctx-average',
            symbol: `XLM${quote}`,
          },
        ]),
        { status: 200 },
      );
    });
    await stroopsPerCent('USD');
    expect(captured).toContain('https://rates.internal.example/v2/rates?source=ctx&symbol=xlmusd');
    // Nothing should still be hitting the hardcoded default host.
    expect(captured.every((u) => u.startsWith('https://rates.internal.example/v2/rates'))).toBe(
      true,
    );
  });

  it('falls back to the historical rates.ctx.com default when the override is unset', async () => {
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      const u = String(url);
      const match = /symbol=xlm(usd|gbp|eur)/i.exec(u);
      const quote = (match?.[1] ?? 'usd').toUpperCase();
      return new Response(
        JSON.stringify([
          {
            baseCurrency: 'XLM',
            price: '0.1610',
            quoteCurrency: quote,
            retrieved: new Date().toISOString(),
            source: 'ctx-average',
            symbol: `XLM${quote}`,
          },
        ]),
        { status: 200 },
      );
    });
    await stroopsPerCent('USD');
    expect(captured).toContain('https://rates.ctx.com/rates?source=ctx&symbol=xlmusd');
  });

  it('rejects a malformed LOOP_XLM_CTX_RATES_URL loudly instead of fetching a broken URL', async () => {
    process.env['LOOP_XLM_CTX_RATES_URL'] = 'not-a-url';
    // The stub returns VALID data: on the un-fixed code (which ignores
    // the override) the USD fetch would succeed and resolve — so the
    // assertion below only holds because the guard throws BEFORE fetch.
    fetchSpy = stubValidCtx();
    await expect(stroopsPerCent('USD')).rejects.toThrow(
      /LOOP_XLM_CTX_RATES_URL is not a valid URL/,
    );
  });

  it('rejects a non-http(s) LOOP_XLM_CTX_RATES_URL scheme', async () => {
    process.env['LOOP_XLM_CTX_RATES_URL'] = 'ftp://rates.internal.example/rates';
    fetchSpy = stubValidCtx();
    await expect(stroopsPerCent('USD')).rejects.toThrow(
      /LOOP_XLM_CTX_RATES_URL must be an http\(s\) URL/,
    );
  });
});

describe('requiredStroopsForCharge (A4-106)', () => {
  it('keeps sub-cent precision so a 0.105 USD/XLM rate yields the correct ceiling', async () => {
    // The audit case: usd=0.105 USD/XLM. Earlier code did
    // Math.round(0.105 * 100) = 11, so stroopsPerCent = ceil(1e7/11)
    // = 909_091. A 1000-cent ($10) order then required 909_091_000
    // stroops, but the true requirement is 1000 / 10.5 = 95.238...
    // XLM = 952_381_000 stroops (ceiling).
    fetchSpy = stubFeed({ stellar: { usd: 0.105 } });
    const required = await requiredStroopsForCharge(1000n, 'USD');
    // 1000 × 10^13 / 10_500_000 = 952_380_952.38... → ceil 952_380_953.
    expect(required).toBe(952_380_953n);
    // Sanity: more stroops than the OLD buggy 909_091_000.
    expect(required).toBeGreaterThan(909_091_000n);
  });

  it('matches stroopsPerCent × chargeMinor when the rate aligns to whole cents', async () => {
    // usd = 0.10 → exact 10 cents/XLM → no rounding loss either way.
    fetchSpy = stubFeed({ stellar: { usd: 0.1 } });
    const required = await requiredStroopsForCharge(1000n, 'USD');
    expect(required).toBe(1000n * 1_000_000n);
  });
});

describe('usdcStroopsPerCent', () => {
  it('returns the static 1:1 rate for USD without touching the feed', async () => {
    // No fetch stub — if the USD path touched the feed, this would throw.
    expect(await usdcStroopsPerCent('USD')).toBe(100_000n);
  });

  it('computes GBP from the FX feed', async () => {
    // Frankfurter-shaped response: 1 USD = 0.78 GBP.
    // → 1 GBP = 1/0.78 USD ≈ 1.282 USD
    // → 1 pence = 0.01282 USD = 128_205 stroops (ceil 128_206).
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
    expect(await usdcStroopsPerCent('GBP')).toBe(128_206n);
  });

  it('computes EUR from the FX feed', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { EUR: 0.92 } });
    // 1 EUR = 1/0.92 USD ≈ 1.0869 USD → 1 cent = 108_696 stroops (ceil).
    expect(await usdcStroopsPerCent('EUR')).toBe(108_696n);
  });

  it('caches across calls within the TTL window', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
    await usdcStroopsPerCent('GBP');
    await usdcStroopsPerCent('EUR');
    await usdcStroopsPerCent('GBP');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honours LOOP_FX_FEED_URL override', async () => {
    process.env['LOOP_FX_FEED_URL'] = 'https://custom.example/fx';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return new Response(JSON.stringify({ base: 'USD', rates: { GBP: 0.78 } }), { status: 200 });
    });
    await usdcStroopsPerCent('GBP');
    expect(captured[0]!).toBe('https://custom.example/fx');
  });

  it('throws on non-2xx', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));
    await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/FX feed 500/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"not":"expected"}', { status: 200 }));
    await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/schema drift/);
  });

  it('throws when the response base is not USD', async () => {
    fetchSpy = stubFeed({ base: 'EUR', rates: { GBP: 0.78 } });
    await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/base is EUR/);
  });

  it('throws when the requested currency has no rate', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { EUR: 0.92 } });
    await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/no rate for USD→GBP/);
  });

  it('throws on a non-positive rate', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0 } });
    await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/non-positive rate/);
  });

  // CF2-06 (2026-06-30 cold audit): the FX feed's bound is tighter than
  // XLM's (10% vs 50%) — fiat pairs essentially never move that much in
  // a 60s window.
  describe('CF2-06: rate sanity bound', () => {
    it('accepts a plausible FX rate change across two refreshes', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
        await usdcStroopsPerCent('GBP');
        // A 5% move is within the 10% FX bound.
        fetchSpy.mockRestore();
        fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.819 } });
        vi.advanceTimersByTime(60_001);
        await expect(usdcStroopsPerCent('GBP')).resolves.not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects an implausible FX rate jump', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
        await usdcStroopsPerCent('GBP');
        // A 50% move — way beyond the 10% FX bound.
        fetchSpy.mockRestore();
        fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 1.17 } });
        vi.advanceTimersByTime(60_001);
        await expect(usdcStroopsPerCent('GBP')).rejects.toThrow(/exceeds sanity bound/);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('convertMinorUnits', () => {
  it('passes through when from === to without touching the feed', async () => {
    // No stub — feed access would throw. USD→USD short-circuits
    // because the conversion is a no-op.
    expect(await convertMinorUnits(5000n, 'USD', 'USD')).toBe(5000n);
    expect(await convertMinorUnits(5000n, 'GBP', 'GBP')).toBe(5000n);
    expect(await convertMinorUnits(5000n, 'EUR', 'EUR')).toBe(5000n);
  });

  it('passes through a zero amount without touching the feed', async () => {
    expect(await convertMinorUnits(0n, 'USD', 'GBP')).toBe(0n);
  });

  it('rejects negative amounts — a negative charge is a bug', async () => {
    await expect(convertMinorUnits(-1n, 'USD', 'GBP')).rejects.toThrow(/negative amount/);
  });

  it('converts USD cents to GBP pence (USD→GBP)', async () => {
    // 5000 USD cents × 0.78 = 3900 GBP pence (exact).
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
    expect(await convertMinorUnits(5000n, 'USD', 'GBP')).toBe(3900n);
  });

  it('rounds up so the charge covers the catalog price under sub-minor rounding', async () => {
    // 5000 × 0.7831 = 3915.5 → ceiling = 3916.
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.7831 } });
    expect(await convertMinorUnits(5000n, 'USD', 'GBP')).toBe(3916n);
  });

  it('converts GBP pence to USD cents (GBP→USD)', async () => {
    // 3900 pence / 0.78 GBP-per-USD = $50.00 → 5000 cents (exact).
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
    expect(await convertMinorUnits(3900n, 'GBP', 'USD')).toBe(5000n);
  });

  it('two-hops GBP → EUR via USD', async () => {
    // 3900 GBP pence → $50 → $50 × 0.92 = 4600 EUR cents (exact).
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
    expect(await convertMinorUnits(3900n, 'GBP', 'EUR')).toBe(4600n);
  });

  it('shares the FX cache with usdcStroopsPerCent', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
    await usdcStroopsPerCent('GBP');
    await convertMinorUnits(5000n, 'USD', 'GBP');
    await convertMinorUnits(3900n, 'GBP', 'EUR');
    // One upstream fetch for all three — if the cache wasn't shared
    // we'd see 2 (or 3) hits.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when the source rate is missing from the feed', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { EUR: 0.92 } });
    await expect(convertMinorUnits(5000n, 'GBP', 'USD')).rejects.toThrow(/no rate for USD→GBP/);
  });

  it('throws when the destination rate is missing from the feed', async () => {
    fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
    await expect(convertMinorUnits(5000n, 'USD', 'EUR')).rejects.toThrow(/no rate for USD→EUR/);
  });

  // ── CF-19 / ADR 035: extended-market source currencies ──────────────
  describe('extended order currencies (CF-19 / ADR 035)', () => {
    it('requests every rate currency (home + extended) in one round-trip', async () => {
      const captured: string[] = [];
      fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        captured.push(String(url));
        return new Response(
          JSON.stringify({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92, AED: 3.67 } }),
          { status: 200 },
        );
      });
      await convertMinorUnits(5000n, 'AED', 'USD');
      // Default Frankfurter URL must enumerate the extended currencies so
      // the feed returns them when it serves them.
      expect(captured[0]!).toContain('to=');
      for (const code of ['GBP', 'EUR', 'AED', 'INR', 'SAR', 'AUD', 'MXN']) {
        expect(captured[0]!).toContain(code);
      }
    });

    it('converts an AED-priced card to USD when the feed serves AED', async () => {
      // 1 USD = 3.67 AED → 3670 AED minor (36.70 AED) = 1000 USD cents.
      fetchSpy = stubFeed({ base: 'USD', rates: { AED: 3.67 } });
      expect(await convertMinorUnits(3670n, 'AED', 'USD')).toBe(1000n);
    });

    it('two-hops an extended currency to a non-USD home currency (AED→GBP)', async () => {
      // 3670 AED minor / 3.67 = $10.00 → $10 × 0.78 = 780 GBP pence.
      fetchSpy = stubFeed({ base: 'USD', rates: { AED: 3.67, GBP: 0.78 } });
      expect(await convertMinorUnits(3670n, 'AED', 'GBP')).toBe(780n);
    });

    it('FAILS GRACEFULLY with CurrencyRateUnavailableError when the feed lacks an extended rate', async () => {
      // The rates service doesn't serve AED yet — the feed returns only
      // home currencies. The order path must NOT crash or charge a wrong
      // amount; it surfaces a typed "coming soon" error instead.
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
      await expect(convertMinorUnits(3670n, 'AED', 'USD')).rejects.toBeInstanceOf(
        CurrencyRateUnavailableError,
      );
    });

    it('the typed error names the unavailable currency', async () => {
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78 } });
      await expect(convertMinorUnits(500n, 'MXN', 'GBP')).rejects.toMatchObject({
        name: 'CurrencyRateUnavailableError',
        currency: 'MXN',
      });
    });

    it('a missing SUPPORTED currency (GBP) stays a plain Error, not the typed one', async () => {
      // Distinguish a genuine feed outage for a currency we DO support
      // (→ 503 SERVICE_UNAVAILABLE) from an unbuilt extended market.
      fetchSpy = stubFeed({ base: 'USD', rates: { EUR: 0.92 } });
      const err = await convertMinorUnits(5000n, 'USD', 'GBP').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CurrencyRateUnavailableError);
      expect((err as Error).message).toMatch(/no rate for USD→GBP/);
    });

    // §P3 (go-live-plan): each of the 5 ADR-035 extended currencies gets
    // its own exact minor-unit conversion assertion — not just the AED
    // example above. All five (AED/INR/SAR/AUD/MXN) are ISO-4217
    // 2-decimal currencies like the three home currencies, so a plain
    // USD-anchored rate divides evenly here; sub-cent ceiling rounding is
    // already covered generically above ("rounds up so the charge covers
    // the catalog price").
    it.each([
      { currency: 'AED', rate: 3.67, minor: 3670n, expectedUsd: 1000n },
      { currency: 'INR', rate: 90, minor: 9000n, expectedUsd: 100n },
      { currency: 'SAR', rate: 3.75, minor: 3750n, expectedUsd: 1000n },
      { currency: 'AUD', rate: 1.5, minor: 1500n, expectedUsd: 1000n },
      { currency: 'MXN', rate: 17.5, minor: 1750n, expectedUsd: 100n },
    ] as const)(
      'converts a $currency-priced card to USD exactly',
      async ({ currency, rate, minor, expectedUsd }) => {
        fetchSpy = stubFeed({ base: 'USD', rates: { [currency]: rate } });
        expect(await convertMinorUnits(minor, currency, 'USD')).toBe(expectedUsd);
      },
    );

    it('each extended currency fails gracefully (not a crash, not a wrong charge) when the feed omits it', async () => {
      // Complements the single-currency (AED) case above — confirms the
      // same typed-error path is generic across all five, not hardcoded
      // to one. Mirrors the real Frankfurter feed today: AED/SAR are
      // absent from the ECB reference-rate table Frankfurter republishes
      // (they're USD-pegged Gulf currencies the ECB doesn't quote), while
      // AUD/INR/MXN are present — so this feed shape ("home only") is a
      // realistic stand-in for AED/SAR specifically, not a hypothetical.
      fetchSpy = stubFeed({ base: 'USD', rates: { GBP: 0.78, EUR: 0.92 } });
      for (const currency of ['AED', 'INR', 'SAR', 'AUD', 'MXN'] as const) {
        await expect(convertMinorUnits(1000n, currency, 'USD')).rejects.toMatchObject({
          name: 'CurrencyRateUnavailableError',
          currency,
        });
      }
    });
  });
});
