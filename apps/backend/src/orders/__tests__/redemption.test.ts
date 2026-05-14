import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

// Mock the operator pool — we control which credentials it returns
// (or null, to skip SSE) and the operatorFetch responses the
// polling fallback consumes.
const { operatorFetchMock, credsState } = vi.hoisted(() => ({
  operatorFetchMock: vi.fn(),
  credsState: {
    current: null as null | { id: string; bearer: string; clientId: string },
  },
}));
vi.mock('../../ctx/operator-pool.js', () => ({
  operatorFetch: (url: string, init?: RequestInit) => operatorFetchMock(url, init),
  pickOperatorCredentials: () => credsState.current,
}));

// Mock the SSE stream client — tests choose whether it resolves,
// throws transient, or throws terminal.
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock('../../ctx/stream.js', () => ({
  streamGiftCardStatus: (...args: unknown[]) => streamMock(...args),
}));

import { waitForRedemption } from '../procurement-redemption.js';

function detailResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  operatorFetchMock.mockReset();
  streamMock.mockReset();
  credsState.current = { id: 'op-1', bearer: 'tok', clientId: 'loopweb' };
});

describe('waitForRedemption', () => {
  it('stream-first: terminal fulfilled → one authoritative GET → returns codes', async () => {
    streamMock.mockResolvedValueOnce({ fulfilmentStatus: 'fulfilled' });
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemCode: 'C', redeemPin: 'P', redeemUrl: 'https://x.example' }),
    );
    const result = await waitForRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: 'P', url: 'https://x.example' });
    // Exactly one CTX call after the stream — the authoritative GET.
    expect(operatorFetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejected/failed/error from the stream propagates so procureOne can fail the order', async () => {
    streamMock.mockRejectedValueOnce(new Error('CTX order o-1 rejected: bad merch'));
    await expect(
      waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 20 }),
    ).rejects.toThrow(/rejected/);
    // No polling after a terminal CTX rejection.
    expect(operatorFetchMock).not.toHaveBeenCalled();
  });

  it('transient stream error → falls back to polling', async () => {
    streamMock.mockRejectedValueOnce(new Error('socket hang up'));
    operatorFetchMock.mockResolvedValueOnce(detailResponse({ redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 200 });
    expect(result.url).toBe('https://x.example');
  });

  it('no healthy operator → skips SSE, polls directly', async () => {
    credsState.current = null;
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ code: 'X', pin: 'Y', url: 'https://x.example' }),
    );
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 200 });
    expect(result).toEqual({ code: 'X', pin: 'Y', url: 'https://x.example' });
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('polling tolerates intermittent failures and returns once codes appear', async () => {
    credsState.current = null;
    operatorFetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(detailResponse({})) // empty fields — polling continues
      .mockResolvedValueOnce(detailResponse({ redeemCode: 'C', redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 200 });
    expect(result.code).toBe('C');
    expect(result.url).toBe('https://x.example');
  });

  it('returns the last (possibly empty) payload when the budget exhausts', async () => {
    credsState.current = null;
    operatorFetchMock.mockResolvedValue(detailResponse({})); // always empty
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 10 });
    expect(result).toEqual({ code: null, pin: null, url: null });
  });
});
