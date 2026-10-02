import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

const ctxFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api-fetch.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ctxFetch: ctxFetchMock,
}));

import {
  loadCtxCurrencies,
  refreshCtxCurrencies,
  ctxCurrency,
  isCtxFiatCurrency,
  isCtxCryptoCurrency,
  getCtxCurrencies,
  __resetCtxCurrenciesForTests,
} from '../currencies.js';

const registry = (): Response =>
  new Response(
    JSON.stringify({
      result: [
        { code: 'GBP', name: 'British Pound', decimals: 2, crypto: false },
        { code: 'XLM', name: 'Stellar Lumens', decimals: 7, crypto: true, chain: 'XLM' },
        { code: 'XLM.USDC', name: 'USD Coin on Stellar', decimals: 7, crypto: true, chain: 'XLM' },
      ],
    }),
    { status: 200 },
  );

describe('ctx currencies', () => {
  beforeEach(() => {
    __resetCtxCurrenciesForTests();
    ctxFetchMock.mockReset();
  });

  it('throws before the registry is loaded', () => {
    expect(() => getCtxCurrencies()).toThrow(/loadCtxCurrencies/);
  });

  it('loads GET /currencies and classifies codes case-insensitively', async () => {
    ctxFetchMock.mockResolvedValueOnce(registry());

    await loadCtxCurrencies();

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/currencies');
    expect(init.method).toBe('GET');
    expect(ctxCurrency('gbp')?.decimals).toBe(2);
    expect(isCtxFiatCurrency('GBP')).toBe(true);
    expect(isCtxCryptoCurrency('GBP')).toBe(false);
    expect(isCtxCryptoCurrency('xlm.usdc')).toBe(true);
    expect(isCtxFiatCurrency('NOPE')).toBe(false);
    expect(isCtxCryptoCurrency('NOPE')).toBe(false);
  });

  it('throws on a non-2xx or malformed response', async () => {
    ctxFetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(loadCtxCurrencies()).rejects.toThrow(/returned 500/);

    ctxFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: [{}] }), { status: 200 }),
    );
    await expect(loadCtxCurrencies()).rejects.toThrow(/shape invalid/);
  });

  it('keeps the last registry when a refresh fails', async () => {
    ctxFetchMock.mockResolvedValueOnce(registry());
    await loadCtxCurrencies();

    ctxFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await refreshCtxCurrencies();

    expect(isCtxFiatCurrency('GBP')).toBe(true);
  });
});
