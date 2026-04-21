import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  stroopsPerCent,
  usdcStroopsPerCent,
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
