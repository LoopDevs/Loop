import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { stroopsPerCent, __resetPriceFeedForTests } from '../price-feed.js';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubFeed(body: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  __resetPriceFeedForTests();
  delete process.env['LOOP_XLM_PRICE_FEED_URL'];
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  __resetPriceFeedForTests();
  delete process.env['LOOP_XLM_PRICE_FEED_URL'];
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
