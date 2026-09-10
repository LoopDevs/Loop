import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

const { ctxFetchMock } = vi.hoisted(() => ({
  ctxFetchMock: vi.fn(),
}));
vi.mock('../../ctx/api-fetch.js', () => ({
  ctxFetch: (url: string, init?: RequestInit) => ctxFetchMock(url, init),
  ctxApiCredentials: () => ({ apiKey: 'key', apiSecret: 'secret', clientId: 'loopweb' }),
}));

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock('../../ctx/stream.js', () => ({
  streamGiftCardStatus: (...args: unknown[]) => streamMock(...args),
}));

const { notifyCtxSchemaDriftMock } = vi.hoisted(() => ({
  notifyCtxSchemaDriftMock: vi.fn<(args: unknown) => void>(() => undefined),
}));
vi.mock('../../discord.js', () => ({
  notifyCtxSchemaDrift: (args: unknown) => notifyCtxSchemaDriftMock(args),
}));

// C2-1: spy on the logger so the log-safety regression tests below can
// assert on exactly what got logged (and, critically, what didn't).
const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../logger.js', () => ({
  logger: { child: () => logMock },
}));

import { fetchRedemption, waitForRedemption } from '../procurement-redemption.js';

function detailResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  ctxFetchMock.mockReset();
  streamMock.mockReset();
  notifyCtxSchemaDriftMock.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.debug.mockReset();
});

describe('waitForRedemption', () => {
  it('stream-first: terminal fulfilled → one authoritative GET → returns codes', async () => {
    streamMock.mockResolvedValueOnce({ fulfilmentStatus: 'fulfilled' });
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({ number: 'C', pin: 'P', redeemUrl: 'https://x.example' }),
    );
    const result = await waitForRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: 'P', url: 'https://x.example' });
    expect(ctxFetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejected/failed/error from the stream propagates so procureOne can fail the order', async () => {
    streamMock.mockRejectedValueOnce(new Error('CTX order o-1 rejected: bad merch'));
    await expect(
      waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 20 }),
    ).rejects.toThrow(/rejected/);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('transient stream error → falls back to polling', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    ctxFetchMock.mockResolvedValueOnce(detailResponse({ redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 200 });
    expect(result.url).toBe('https://x.example');
  });

  it('schema drift on detail fetch pages the drift channel and returns null payload', async () => {
    ctxFetchMock.mockResolvedValueOnce(detailResponse({ redeemUrl: 123 }));
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });
    expect(notifyCtxSchemaDriftMock).toHaveBeenCalledWith({
      surface: 'GET /gift-cards/:id',
      issuesSummary: expect.stringContaining('redeemUrl'),
    });
  });

  it('keeps usable code/PIN when CTX returns a non-absolute redeemUrl, nulling the unusable url', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({ number: 'C', pin: 'P', redeemUrl: '/relative/redeem' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: 'P', url: null });
    expect(notifyCtxSchemaDriftMock).not.toHaveBeenCalled();
  });

  it('F10: never persists a non-http(s) redeem URL — javascript: is nulled, code/PIN survive', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({ number: 'C', redeemUrl: 'javascript:alert(document.cookie)' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: null, url: null });
  });

  it('F10: a genuine https redeem URL passes through untouched', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemUrl: 'https://redeem.example.com/card/123' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: 'https://redeem.example.com/card/123' });
  });

  it('barcode-merchant shape: `number` + `pin` collapse into code + pin', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({
        number: '8711653414464265',
        pin: '6741',
        barcodeType: 'code128',
        redeemType: 'barcode',
      }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: '8711653414464265', pin: '6741', url: null });
  });

  it('C2-1: never logs the raw response body once a redemption field is present (codes are PII)', async () => {
    ctxFetchMock.mockResolvedValueOnce(detailResponse({ number: 'SECRET-CODE-1234', pin: '9999' }));
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'SECRET-CODE-1234', pin: '9999', url: null });
    expect(logMock.info).not.toHaveBeenCalled();
    const allCalls = [
      ...logMock.info.mock.calls,
      ...logMock.warn.mock.calls,
      ...logMock.error.mock.calls,
      ...logMock.debug.mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain('SECRET-CODE-1234');
    expect(JSON.stringify(allCalls)).not.toContain('9999');
  });

  it('logs a diagnostic (keys only) only when every redemption field comes back null', async () => {
    ctxFetchMock.mockResolvedValueOnce(detailResponse({ someUnrelatedField: 'x' }));
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });
    expect(logMock.info).toHaveBeenCalledTimes(1);
    const [meta, message] = logMock.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('no redemption fields');
    expect(meta['keys']).toEqual(['someUnrelatedField']);
  });

  it('FT-14: an all-null redemption with a DRIFTED field name never leaks the live code/PIN in the diagnostic log', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      detailResponse({ cardNumber: 'LIVE-CODE-4242', securityPin: '7788' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });

    expect(logMock.info).toHaveBeenCalledTimes(1);
    const [meta, message] = logMock.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('no redemption fields');
    expect(meta['keys']).toEqual(['cardNumber', 'securityPin']);

    const allCalls = [
      ...logMock.info.mock.calls,
      ...logMock.warn.mock.calls,
      ...logMock.error.mock.calls,
      ...logMock.debug.mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain('LIVE-CODE-4242');
    expect(JSON.stringify(allCalls)).not.toContain('7788');
  });

  it('polling tolerates intermittent failures and returns once codes appear', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    ctxFetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(detailResponse({}))
      .mockResolvedValueOnce(detailResponse({ number: 'C', redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 200 });
    expect(result.code).toBe('C');
    expect(result.url).toBe('https://x.example');
  });

  it('returns the last (possibly empty) payload when the budget exhausts', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    ctxFetchMock.mockImplementation(async () => detailResponse({}));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 10 });
    expect(result).toEqual({ code: null, pin: null, url: null });
  });

  it('each poll tick performs a genuinely fresh fetch+read (N ticks → N fetches)', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    let calls = 0;
    ctxFetchMock.mockImplementation(async () => {
      calls++;
      return calls < 4 ? detailResponse({}) : detailResponse({ number: 'LATE-CODE', pin: '9876' });
    });
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 5_000 });
    expect(result).toEqual({ code: 'LATE-CODE', pin: '9876', url: null });
    expect(ctxFetchMock).toHaveBeenCalledTimes(4);
  });

  it('a consumed-body failure on one tick does not poison subsequent ticks', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    const consumed = detailResponse({});
    await consumed.json();
    ctxFetchMock
      .mockResolvedValueOnce(consumed)
      .mockResolvedValueOnce(detailResponse({ redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 5_000 });
    expect(result.url).toBe('https://x.example');
    expect(ctxFetchMock).toHaveBeenCalledTimes(2);
  });
});
