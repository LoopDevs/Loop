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
  operatorFetchMock.mockReset();
  streamMock.mockReset();
  notifyCtxSchemaDriftMock.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.debug.mockReset();
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

  it('keeps usable code/PIN when CTX returns a non-absolute redeemUrl, nulling the unusable url', async () => {
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemCode: 'C', redeemPin: 'P', redeemUrl: '/relative/redeem' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: 'P', url: null });
    expect(notifyCtxSchemaDriftMock).not.toHaveBeenCalled();
  });

  it('F10: never persists a non-http(s) redeem URL — javascript: is nulled, code/PIN survive', async () => {
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemCode: 'C', redeemUrl: 'javascript:alert(document.cookie)' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: 'C', pin: null, url: null });
  });

  it('F10: a genuine https redeem URL passes through untouched', async () => {
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemUrl: 'https://redeem.example.com/card/123' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: 'https://redeem.example.com/card/123' });
  });

  it('C2-1: never logs the raw response body once a redemption field is present (codes are PII)', async () => {
    // procurement-redemption.ts's diagnostic "capturing shape for
    // diagnosis" log is gated on ALL THREE fields being null — its own
    // doc-comment says this is deliberate ("once any code/pin/url is
    // populated the codes are PII and must not land in logs"). Pin
    // that contract directly: a response carrying a real code/PIN must
    // never surface in any log call, at any level.
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redeemCode: 'SECRET-CODE-1234', redeemPin: '9999' }),
    );
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
    operatorFetchMock.mockResolvedValueOnce(detailResponse({ someUnrelatedField: 'x' }));
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });
    expect(logMock.info).toHaveBeenCalledTimes(1);
    const [meta, message] = logMock.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('no redemption fields');
    expect(meta['keys']).toEqual(['someUnrelatedField']);
  });

  it('FT-14: an all-null redemption with a DRIFTED field name never leaks the live code/PIN in the diagnostic log', async () => {
    // Field-name drift: CTX renames redeemCode→redemptionCode /
    // redeemPin→redemptionPin. Our parser sees all KNOWN fields absent, so
    // `out` is all-null and the "capturing shape" diagnostic fires — which
    // is *exactly* the branch where the drifted field is still carrying a
    // LIVE gift-card code/PIN. The old code logged the raw body here,
    // leaking it. The key NAMES may be logged (they answer drift-vs-empty);
    // the VALUES must never appear in any log call. Note the shapes below
    // (a hyphenated code, a 4-digit PIN) deliberately slip past the token /
    // card-shape scrubber, proving keys-only is required, not just scrubbing.
    operatorFetchMock.mockResolvedValueOnce(
      detailResponse({ redemptionCode: 'LIVE-CODE-4242', redemptionPin: '7788' }),
    );
    const result = await fetchRedemption('o-1');
    expect(result).toEqual({ code: null, pin: null, url: null });

    // Diagnostic still fires (all-null) and still records the key names.
    expect(logMock.info).toHaveBeenCalledTimes(1);
    const [meta, message] = logMock.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('no redemption fields');
    expect(meta['keys']).toEqual(['redemptionCode', 'redemptionPin']);

    // ...but the live code + PIN must not surface in ANY log call/level.
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
