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

import { runProcurementTick } from '../procurement.js';
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

beforeEach(() => {
  state.paid = [];
  markProcuringMock.mockReset();
  markFulfilledMock.mockReset();
  markFailedMock.mockReset();
  operatorFetchMock.mockReset();
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

  it('happy path: paid → procuring → CTX POST → fulfilled', async () => {
    state.paid = [makeOrder({ id: 'o-1' })];
    operatorFetchMock.mockResolvedValue(okCtxResponse('ctx-abc'));
    const r = await runProcurementTick();
    expect(r.picked).toBe(1);
    expect(r.fulfilled).toBe(1);
    expect(r.failed).toBe(0);
    expect(markProcuringMock).toHaveBeenCalledWith('o-1', { ctxOperatorId: 'pool' });
    expect(markFulfilledMock).toHaveBeenCalledWith('o-1', { ctxOrderId: 'ctx-abc' });
  });

  it('sends the expected CTX body (merchantId, fiatCurrency, fiatAmount as major-unit string)', async () => {
    state.paid = [
      makeOrder({ id: 'o-1', merchantId: 'target', currency: 'USD', faceValueMinor: 2_500n }),
    ];
    operatorFetchMock.mockResolvedValue(okCtxResponse('ctx-1'));
    await runProcurementTick();
    expect(operatorFetchMock).toHaveBeenCalledWith(
      'https://ctx.example/gift-cards',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = operatorFetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      cryptoCurrency: 'XLM',
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
    operatorFetchMock.mockResolvedValue(okCtxResponse('ctx-abc'));
    markFulfilledMock.mockResolvedValue(null);
    const r = await runProcurementTick();
    expect(r.skipped).toBe(1);
    expect(r.fulfilled).toBe(0);
  });

  it('processes multiple orders and aggregates counts', async () => {
    state.paid = [makeOrder({ id: 'o-1' }), makeOrder({ id: 'o-2' }), makeOrder({ id: 'o-3' })];
    let call = 0;
    operatorFetchMock.mockImplementation(async () => {
      call++;
      if (call === 2) return new Response('boom', { status: 502 });
      return okCtxResponse(`ctx-${call}`);
    });
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
