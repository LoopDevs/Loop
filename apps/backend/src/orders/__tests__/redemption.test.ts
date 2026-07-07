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

const { notifyCtxSchemaDriftMock } = vi.hoisted(() => ({
  notifyCtxSchemaDriftMock: vi.fn<(args: unknown) => void>(() => undefined),
}));
vi.mock('../../discord.js', () => ({
  notifyCtxSchemaDrift: (args: unknown) => notifyCtxSchemaDriftMock(args),
}));

import { fetchRedemption, waitForRedemption } from '../procurement-redemption.js';

function detailResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  operatorFetchMock.mockReset();
  streamMock.mockReset();
  notifyCtxSchemaDriftMock.mockReset();
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

  it('schema drift on detail fetch pages the drift channel and returns null payload', async () => {
    operatorFetchMock.mockResolvedValueOnce(detailResponse({ redeemUrl: 123 }));
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });
    expect(notifyCtxSchemaDriftMock).toHaveBeenCalledWith({
      surface: 'GET /gift-cards/:id',
      issuesSummary: expect.stringContaining('redeemUrl'),
    });
  });

  it('keeps usable code/PIN even when CTX returns a non-absolute redeemUrl string', async () => {
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemCode: 'C', redeemPin: 'P', redeemUrl: '/relative/redeem' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: 'P', url: '/relative/redeem' });
    expect(notifyCtxSchemaDriftMock).not.toHaveBeenCalled();
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
    // Audit 2026-06 regression guard: build a FRESH Response per tick.
    // The previous fixture resolved one shared Response object via
    // `mockResolvedValue(detailResponse({}))`, so every tick after the
    // first threw `Body is unusable: Body has already been read` inside
    // fetchRedemption — the catch-and-continue in the polling loop
    // swallowed it and the suite passed while the retry path was never
    // actually exercised.
    operatorFetchMock.mockImplementation(async () => detailResponse({})); // always empty
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 10 });
    expect(result).toEqual({ code: null, pin: null, url: null });
  });

  it('each poll tick performs a genuinely fresh fetch+read (N ticks → N fetches)', async () => {
    credsState.current = null;
    // Empty payloads for the first three ticks, codes on the fourth.
    // Every Response is a fresh object so every tick must complete a
    // full fetch + json() parse — if any tick re-read a consumed body
    // (the audited "Body is unusable" bug) the code would never be
    // observed and the budget would exhaust to nulls.
    let calls = 0;
    operatorFetchMock.mockImplementation(async () => {
      calls++;
      return calls < 4
        ? detailResponse({})
        : detailResponse({ redeemCode: 'LATE-CODE', redeemPin: '9876' });
    });
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 5_000 });
    expect(result).toEqual({ code: 'LATE-CODE', pin: '9876', url: null });
    // Exactly one fetch per poll tick — the recovery tick is the 4th.
    expect(operatorFetchMock).toHaveBeenCalledTimes(4);
  });

  it('a consumed-body failure on one tick does not poison subsequent ticks', async () => {
    credsState.current = null;
    // Defence-in-depth for the audited bug class: tick 1 receives a
    // Response whose body was already consumed (simulating any future
    // shared-Response regression); tick 2 gets a healthy fresh one.
    // The loop must survive the body-reuse error and recover on the
    // next genuinely fresh fetch.
    const consumed = detailResponse({});
    await consumed.json(); // consume the body up-front
    operatorFetchMock
      .mockResolvedValueOnce(consumed)
      .mockResolvedValueOnce(detailResponse({ redeemUrl: 'https://x.example' }));
    const result = await waitForRedemption('o-1', { pollIntervalMs: 1, totalTimeoutMs: 5_000 });
    expect(result.url).toBe('https://x.example');
    expect(operatorFetchMock).toHaveBeenCalledTimes(2);
  });
});
