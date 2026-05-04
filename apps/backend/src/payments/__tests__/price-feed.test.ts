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
  __resetPriceFeedForTests,
  __resetFxFeedForTests,
} from '../price-feed.js';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubFeed(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  __resetPriceFeedForTests();
  __resetFxFeedForTests();
  delete process.env['LOOP_XLM_PRICE_FEED_URL'];
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
});
