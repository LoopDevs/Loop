import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock('../../upstream.js', () => ({
  upstreamUrl: (path: string) => `https://ctx.example${path}`,
}));

const markProcuringMock = vi.fn();
const markFulfilledMock = vi.fn();
const markFailedMock = vi.fn();
const operatorFetchMock = vi.fn();

vi.mock('../transitions.js', () => ({
  markOrderProcuring: (id: string, o: unknown) => markProcuringMock(id, o),
  markOrderFulfilled: (id: string, o: unknown) => markFulfilledMock(id, o),
  markOrderFailed: (id: string, reason: string) => markFailedMock(id, reason),
}));
vi.mock('../../ctx/operator-pool.js', () => {
  class OperatorPoolUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'OperatorPoolUnavailableError';
    }
  }
  return {
    operatorFetch: (url: string, init?: RequestInit) => operatorFetchMock(url, init),
    OperatorPoolUnavailableError,
  };
});

// db mock for runProcurementTick's paid-orders query — chain
// select().from().where().orderBy().limit() resolves to the stashed
// paid-orders list.
const { dbMock, state } = vi.hoisted(() => {
  const s: { paid: unknown[] } = { paid: [] };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['orderBy'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => s.paid);
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: {
      state: 'state',
      paidAt: 'paid_at',
    },
  };
});

// Env + Horizon-balance mock — default: no floor configured so the
// procurement tick skips the Horizon call entirely and defaults to
// USDC. Tests that exercise the fallback override `envState.floor`
// and `balancesState.usdc`.
const { envState, balancesState, getBalancesMock } = vi.hoisted(() => {
  const env = {
    LOOP_STELLAR_DEPOSIT_ADDRESS: undefined as string | undefined,
    LOOP_STELLAR_USDC_ISSUER: undefined as string | undefined,
    LOOP_STELLAR_USDC_FLOOR_STROOPS: undefined as bigint | undefined,
  };
  const balances = {
    usdc: null as bigint | null,
    throwErr: null as Error | null,
  };
  return {
    envState: env,
    balancesState: balances,
    getBalancesMock: vi.fn(async () => {
      if (balances.throwErr !== null) throw balances.throwErr;
      return { xlmStroops: null, usdcStroops: balances.usdc, asOfMs: Date.now() };
    }),
  };
});
vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));
vi.mock('../../payments/horizon-balances.js', () => ({
  getAccountBalances: getBalancesMock,
}));

import { runProcurementTick, pickProcurementAsset } from '../procurement.js';
import { OperatorPoolUnavailableError } from '../../ctx/operator-pool.js';

type AnyOrder = {
  id: string;
  merchantId: string;
  currency: string;
  faceValueMinor: bigint;
};

function makeOrder(overrides: Partial<AnyOrder> = {}): AnyOrder {
  return {
    id: 'order-1',
    merchantId: 'm1',
    currency: 'GBP',
    faceValueMinor: 10_000n,
    ...overrides,
  };
}

function okCtxResponse(id: string): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ctxDetailResponse(
  fields: { redeemCode?: string; redeemPin?: string; redeemUrl?: string } = {},
): Response {
  return new Response(JSON.stringify(fields), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Wires two CTX responses in order: POST /gift-cards, then GET /gift-cards/:id. */
function mockProcureAndFetch(
  id: string,
  detail: Parameters<typeof ctxDetailResponse>[0] = {},
): void {
  operatorFetchMock
    .mockResolvedValueOnce(okCtxResponse(id))
    .mockResolvedValueOnce(ctxDetailResponse(detail));
}

beforeEach(() => {
  state.paid = [];
  markProcuringMock.mockReset();
  markFulfilledMock.mockReset();
  markFailedMock.mockReset();
  operatorFetchMock.mockReset();
  getBalancesMock.mockClear();
  envState.LOOP_STELLAR_DEPOSIT_ADDRESS = undefined;
  envState.LOOP_STELLAR_USDC_ISSUER = undefined;
  envState.LOOP_STELLAR_USDC_FLOOR_STROOPS = undefined;
  balancesState.usdc = null;
  balancesState.throwErr = null;
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
  // Default happy behaviours — tests override as needed.
  markProcuringMock.mockImplementation(async (id: string) => ({ id }));
  markFulfilledMock.mockImplementation(async (id: string) => ({ id }));
});

describe('runProcurementTick', () => {
  it('no paid orders → zero counts, no calls', async () => {
    const r = await runProcurementTick();
    expect(r.picked).toBe(0);
    expect(operatorFetchMock).not.toHaveBeenCalled();
    expect(markProcuringMock).not.toHaveBeenCalled();
  });

  it('happy path: paid → procuring → CTX POST → fetch detail → fulfilled', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-abc', {
      redeemCode: 'ABC-123',
      redeemPin: '4242',
      redeemUrl: 'https://example.com/redeem/xyz',
    });
    const r = await runProcurementTick();
    expect(r.picked).toBe(1);
    expect(r.fulfilled).toBe(1);
    expect(r.failed).toBe(0);
    expect(markProcuringMock).toHaveBeenCalledWith('o-1', { ctxOperatorId: 'pool' });
    expect(markFulfilledMock).toHaveBeenCalledWith('o-1', {
      ctxOrderId: 'ctx-abc',
      redemption: {
        code: 'ABC-123',
        pin: '4242',
        url: 'https://example.com/redeem/xyz',
      },
    });
    // Two operator calls: POST /gift-cards then GET /gift-cards/<id>.
    expect(operatorFetchMock).toHaveBeenCalledTimes(2);
    expect(operatorFetchMock.mock.calls[1]![0]).toMatch(/\/gift-cards\/ctx-abc$/);
  });

  it('fulfillment persists nulls when CTX detail fetch fails', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock
      .mockResolvedValueOnce(okCtxResponse('ctx-abc'))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const r = await runProcurementTick();
    expect(r.fulfilled).toBe(1);
    expect(markFulfilledMock).toHaveBeenCalledWith('o-1', {
      ctxOrderId: 'ctx-abc',
      redemption: { code: null, pin: null, url: null },
    });
  });

  it('accepts alternative CTX field aliases (code / pin / url)', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockResolvedValueOnce(okCtxResponse('ctx-abc')).mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'C', pin: 'P', url: 'https://x.example' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await runProcurementTick();
    expect(markFulfilledMock).toHaveBeenCalledWith('o-1', {
      ctxOrderId: 'ctx-abc',
      redemption: {
        code: 'C',
        pin: 'P',
        url: 'https://x.example',
      },
    });
  });

  it('sends the expected CTX body (merchantId, fiatCurrency, fiatAmount as major-unit string)', async () => {
    state.paid = [
      makeOrder({ id: 'o-1', merchantId: 'target', currency: 'USD', faceValueMinor: 2_500n }),
    ];
    mockProcureAndFetch('ctx-1');
    await runProcurementTick();
    expect(operatorFetchMock).toHaveBeenCalledWith(
      'https://ctx.example/gift-cards',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      // ADR 015 — procurement defaults to USDC. Without a configured
      // USDC floor + a below-floor balance read, there's nothing to
      // trigger the XLM fallback.
      cryptoCurrency: 'USDC',
      fiatCurrency: 'USD',
      fiatAmount: '25.00',
      merchantId: 'target',
    });
  });

  it('another worker already claimed order → skipped, no CTX call', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    markProcuringMock.mockResolvedValue(null);
    const r = await runProcurementTick();
    expect(r.skipped).toBe(1);
    expect(operatorFetchMock).not.toHaveBeenCalled();
  });

  it('CTX non-ok response → markOrderFailed', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await runProcurementTick();
    expect(r.failed).toBe(1);
    expect(markFailedMock).toHaveBeenCalledWith('o-1', expect.stringMatching(/CTX returned 500/));
    expect(markFulfilledMock).not.toHaveBeenCalled();
  });

  it('CTX response schema drift → markOrderFailed', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ not_an_id: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await runProcurementTick();
    expect(r.failed).toBe(1);
    expect(markFailedMock).toHaveBeenCalledWith('o-1', expect.stringMatching(/schema drift/));
  });

  it('operator pool unavailable → order stays procuring, skipped (no mark-failed)', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockRejectedValue(new OperatorPoolUnavailableError('pool exhausted'));
    const r = await runProcurementTick();
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it('unexpected throw → markOrderFailed with message', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockRejectedValue(new Error('connection reset'));
    const r = await runProcurementTick();
    expect(r.failed).toBe(1);
    expect(markFailedMock).toHaveBeenCalledWith('o-1', expect.stringContaining('connection reset'));
  });

  it('markOrderFulfilled returning null → outcome is skipped (race with another tick)', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-abc');
    markFulfilledMock.mockResolvedValue(null);
    const r = await runProcurementTick();
    expect(r.skipped).toBe(1);
    expect(r.fulfilled).toBe(0);
  });

  it('processes multiple orders and aggregates counts', async () => {
    state.paid = [makeOrder({ id: 'o-1' }), makeOrder({ id: 'o-2' }), makeOrder({ id: 'o-3' })];
    // Each successful order makes 2 calls: POST then GET detail.
    // Order 1: POST ok, GET ok → fulfilled.
    // Order 2: POST fails with 502 → failed (no second call).
    // Order 3: POST ok, GET ok → fulfilled.
    operatorFetchMock
      .mockResolvedValueOnce(okCtxResponse('ctx-1'))
      .mockResolvedValueOnce(ctxDetailResponse())
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(okCtxResponse('ctx-3'))
      .mockResolvedValueOnce(ctxDetailResponse());
    const r = await runProcurementTick();
    expect(r.picked).toBe(3);
    expect(r.fulfilled).toBe(2);
    expect(r.failed).toBe(1);
  });

  it('honours the explicit limit arg', async () => {
    state.paid = []; // limit just reaches the db layer
    await runProcurementTick({ limit: 3 });
    expect(dbMock['limit']!).toHaveBeenCalledWith(3);
  });

  it('defaults limit to 10', async () => {
    state.paid = [];
    await runProcurementTick();
    expect(dbMock['limit']!).toHaveBeenCalledWith(10);
  });
});

describe('runProcurementTick — USDC floor / Horizon wiring', () => {
  it('skips the Horizon read entirely when no floor is configured', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-a');
    await runProcurementTick();
    expect(getBalancesMock).not.toHaveBeenCalled();
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ cryptoCurrency: 'USDC' });
  });

  it('skips the Horizon read when floor is set but deposit address is not (pre-deploy env)', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-a');
    envState.LOOP_STELLAR_USDC_FLOOR_STROOPS = 10n ** 9n;
    await runProcurementTick();
    expect(getBalancesMock).not.toHaveBeenCalled();
  });

  it('reads balance + picks USDC when balance is above the floor', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-a');
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    envState.LOOP_STELLAR_USDC_FLOOR_STROOPS = 10n ** 9n; // 100 USDC
    balancesState.usdc = 5n * 10n ** 9n; // 500 USDC — well above
    await runProcurementTick();
    expect(getBalancesMock).toHaveBeenCalledTimes(1);
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ cryptoCurrency: 'USDC' });
  });

  it('falls back to XLM when USDC balance dips below the floor', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-a');
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    envState.LOOP_STELLAR_USDC_FLOOR_STROOPS = 10n ** 9n;
    balancesState.usdc = 5n * 10n ** 8n; // 50 USDC — below 100-USDC floor
    await runProcurementTick();
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ cryptoCurrency: 'XLM' });
  });

  it('gracefully defaults to USDC when Horizon throws (no stalling procurement)', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    mockProcureAndFetch('ctx-a');
    envState.LOOP_STELLAR_DEPOSIT_ADDRESS = 'GACCOUNT';
    envState.LOOP_STELLAR_USDC_FLOOR_STROOPS = 10n ** 9n;
    balancesState.throwErr = new Error('Horizon 503');
    await runProcurementTick();
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ cryptoCurrency: 'USDC' });
  });
});

describe('pickProcurementAsset', () => {
  it('defaults to USDC when no floor is configured', () => {
    expect(pickProcurementAsset({ balanceStroops: 0n, floorStroops: null })).toBe('USDC');
    expect(pickProcurementAsset({ balanceStroops: null, floorStroops: null })).toBe('USDC');
  });

  it('defaults to USDC when no balance has been read (live Horizon integration pending)', () => {
    expect(pickProcurementAsset({ balanceStroops: null, floorStroops: 10n ** 9n })).toBe('USDC');
  });

  it('picks USDC when balance is at or above the floor', () => {
    const floor = 10n ** 9n; // 100 USDC in stroops
    expect(pickProcurementAsset({ balanceStroops: floor, floorStroops: floor })).toBe('USDC');
    expect(pickProcurementAsset({ balanceStroops: floor + 1n, floorStroops: floor })).toBe('USDC');
  });

  it('falls back to XLM when balance is below the floor', () => {
    const floor = 10n ** 9n;
    expect(pickProcurementAsset({ balanceStroops: floor - 1n, floorStroops: floor })).toBe('XLM');
    expect(pickProcurementAsset({ balanceStroops: 0n, floorStroops: floor })).toBe('XLM');
  });
});
