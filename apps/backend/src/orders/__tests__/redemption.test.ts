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

import { fetchRedemption } from '../procurement-redemption.js';

function detailResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  ctxFetchMock.mockReset();
  notifyCtxSchemaDriftMock.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.debug.mockReset();
});

describe('fetchRedemption', () => {
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
});
