/**
 * Admin order re-drive lever (A5-1). This file covers the HANDLER
 * edge: state-eligibility routing, the staleness + ctx-already-paid
 * guards on `procuring` orders, the outcome → status mapping, and the
 * no-snapshot-on-failure contract.
 *
 * The underlying money-safety invariants this handler *delegates to*
 * (rather than reimplements) are proven elsewhere and NOT re-tested
 * here:
 *   - `markOrderProcuring`'s `WHERE state='paid'` CAS — "another
 *     worker already claimed order → skipped, no CTX call" in
 *     `orders/__tests__/procurement.test.ts`.
 *   - `payCtxOrder`'s `ctx_settlements` durable-record idempotency
 *     (INV-7, no double-pay-CTX across re-runs) — the `A4:` cases in
 *     `orders/__tests__/pay-ctx.test.ts`.
 * What IS proven here: the handler calls `procureOne` AT MOST ONCE
 * per redrive attempt, never calls it at all when a guard trips, and
 * a same-key double-click converges to one `procureOne` call via the
 * idempotency-guard replay (first line of defence; the CAS + settlement
 * record above are the second, order-row-level line that holds even
 * across two DIFFERENT idempotency keys).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { PROCUREMENT_TIMEOUT_MS } = vi.hoisted(() => ({
  PROCUREMENT_TIMEOUT_MS: 15 * 60 * 1000,
}));

const state = vi.hoisted(() => ({
  orders: new Map<string, Record<string, unknown>>(),
  // Optional per-call override queue: when non-empty, `getOrderById`
  // shifts from here instead of reading `orders` — lets a test give
  // the INITIAL fetch and the POST-attempt re-fetch different rows,
  // proving the handler reports the fresh re-read rather than
  // inferring state from `outcome`.
  orderSequence: [] as Array<Record<string, unknown> | null>,
  procureCalls: [] as Array<Record<string, unknown>>,
  procureOutcome: 'fulfilled' as 'fulfilled' | 'failed' | 'skipped',
  revertCalls: [] as string[],
  revertReturns: null as Record<string, unknown> | null,
  loopPaidCtxCalls: [] as string[],
  loopPaidCtxReturn: false,
  snapshotStored: false,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../orders/repo.js', () => ({
  getOrderById: vi.fn(async (id: string) => {
    if (state.orderSequence.length > 0) return state.orderSequence.shift() ?? null;
    return state.orders.get(id) ?? null;
  }),
}));

vi.mock('../../orders/procure-one.js', () => ({
  procureOne: vi.fn(async (order: Record<string, unknown>) => {
    state.procureCalls.push(order);
    return state.procureOutcome;
  }),
}));

vi.mock('../../orders/transitions.js', () => ({
  revertOrderProcuringToPaid: vi.fn(async (id: string) => {
    state.revertCalls.push(id);
    return state.revertReturns;
  }),
}));

vi.mock('../../orders/transitions-sweeps.js', () => ({
  loopPaidCtx: vi.fn(async (id: string) => {
    state.loopPaidCtxCalls.push(id);
    return state.loopPaidCtxReturn;
  }),
}));

vi.mock('../../orders/procurement-worker.js', () => ({
  PROCUREMENT_TIMEOUT_MS,
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: unknown,
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      state.snapshotStored = true;
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminRedriveOrderHandler } from '../order-redrive.js';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@loop.test' };
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  orderId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'orderId' ? (args.orderId ?? ORDER_ID) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const redrive = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
  adminRedriveOrderHandler(
    makeCtx({
      headers: { 'idempotency-key': validKey },
      body: { reason: 'stuck order, worker looks dead, re-driving' },
      ...over,
    }),
  );

function makeOrder(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    state: 'paid',
    procuredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.orders = new Map([[ORDER_ID, makeOrder()]]);
  state.orderSequence = [];
  state.procureCalls = [];
  state.procureOutcome = 'fulfilled';
  state.revertCalls = [];
  state.revertReturns = null;
  state.loopPaidCtxCalls = [];
  state.loopPaidCtxReturn = false;
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminRedriveOrderHandler — paid orders', () => {
  it('200: redrives a paid order directly (no revert, no ctx-paid check)', async () => {
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ orderId: ORDER_ID, outcome: 'fulfilled', state: 'paid' });
    expect(state.procureCalls).toHaveLength(1);
    expect(state.procureCalls[0]?.id).toBe(ORDER_ID);
    expect(state.revertCalls).toEqual([]);
    expect(state.loopPaidCtxCalls).toEqual([]);
    expect(state.discordCalls).toHaveLength(1);
  });

  it('reports the fresh post-attempt state via a second read, not the pre-attempt one', async () => {
    // First getOrderById call (eligibility check) sees 'paid'; the
    // SECOND call (post-procureOne re-fetch) sees 'fulfilled' — proves
    // the handler reports the fresh re-read, not an assumption
    // derived from `outcome`.
    state.orderSequence = [makeOrder({ state: 'paid' }), makeOrder({ state: 'fulfilled' })];
    const res = await redrive();
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ orderId: ORDER_ID, outcome: 'fulfilled', state: 'fulfilled' });
  });

  it('outcome=skipped (another worker already claimed it) still 200s with the real final state', async () => {
    // A `paid` order redrive is always attempted directly — no
    // staleness gate applies. `procureOne` itself reports `skipped`
    // when its own `markOrderProcuring` CAS loses the claim to a
    // live worker (proven independently in procurement.test.ts's
    // "another worker already claimed order" case); this test only
    // proves the handler surfaces that outcome + the fresh state
    // faithfully rather than assuming success. The winning worker
    // left the row in 'procuring' by the time the handler re-reads.
    state.procureOutcome = 'skipped';
    state.orderSequence = [makeOrder({ state: 'paid' }), makeOrder({ state: 'procuring' })];
    const res = await redrive();
    expect(res.status).toBe(200);
    expect(state.procureCalls).toHaveLength(1);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ orderId: ORDER_ID, outcome: 'skipped', state: 'procuring' });
  });
});

describe('adminRedriveOrderHandler — procuring orders', () => {
  it('409 ORDER_REDRIVE_NOT_STALE when procuredAt is recent — no revert, no procureOne', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', procuredAt: new Date(Date.now() - 60_000) }),
    );
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_NOT_STALE');
    expect(state.revertCalls).toEqual([]);
    expect(state.procureCalls).toEqual([]);
    expect(state.loopPaidCtxCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('409 ORDER_REDRIVE_NOT_STALE when procuredAt is null (never actually started procuring)', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'procuring', procuredAt: null }));
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_NOT_STALE');
  });

  it('409 ORDER_REDRIVE_CTX_ALREADY_PAID when stale but Loop already paid CTX — no revert, no procureOne', async () => {
    state.orders.set(
      ORDER_ID,
      makeOrder({
        state: 'procuring',
        procuredAt: new Date(Date.now() - PROCUREMENT_TIMEOUT_MS - 1000),
      }),
    );
    state.loopPaidCtxReturn = true;
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_CTX_ALREADY_PAID');
    expect(state.loopPaidCtxCalls).toEqual([ORDER_ID]);
    expect(state.revertCalls).toEqual([]);
    expect(state.procureCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('200: stale + not ctx-paid → reverts to paid, then redrives the REVERTED row', async () => {
    const staleProcuredAt = new Date(Date.now() - PROCUREMENT_TIMEOUT_MS - 1000);
    state.orders.set(ORDER_ID, makeOrder({ state: 'procuring', procuredAt: staleProcuredAt }));
    const reverted = makeOrder({ state: 'paid', procuredAt: null });
    state.revertReturns = reverted;
    state.loopPaidCtxReturn = false;

    const res = await redrive();
    expect(res.status).toBe(200);
    expect(state.revertCalls).toEqual([ORDER_ID]);
    expect(state.procureCalls).toHaveLength(1);
    // The handler must redrive the FRESH reverted row, not the stale
    // pre-revert one still carrying state='procuring'.
    expect(state.procureCalls[0]).toEqual(reverted);
  });

  it('409 ORDER_REDRIVE_STATE_CHANGED when the revert loses the race (CAS returns null)', async () => {
    const staleProcuredAt = new Date(Date.now() - PROCUREMENT_TIMEOUT_MS - 1000);
    state.orders.set(ORDER_ID, makeOrder({ state: 'procuring', procuredAt: staleProcuredAt }));
    state.revertReturns = null; // something else already moved the row
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_STATE_CHANGED');
    expect(state.procureCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });
});

describe('adminRedriveOrderHandler — ineligible / not-found states', () => {
  it('404 when the order does not exist', async () => {
    state.orders = new Map();
    const res = await redrive();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(state.procureCalls).toEqual([]);
  });

  it.each(['fulfilled', 'failed', 'expired', 'pending_payment'])(
    '400 ORDER_NOT_REDRIVABLE for terminal/pre-payment state %s',
    async (terminalState) => {
      state.orders.set(ORDER_ID, makeOrder({ state: terminalState }));
      const res = await redrive();
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('ORDER_NOT_REDRIVABLE');
      expect(state.procureCalls).toEqual([]);
      expect(state.snapshotStored).toBe(false);
    },
  );
});

describe('adminRedriveOrderHandler — request validation', () => {
  it('400 on bad orderId / missing idempotency key / missing reason', async () => {
    expect((await redrive({ orderId: 'nope' })).status).toBe(400);
    expect((await redrive({ headers: {} })).status).toBe(400);
    expect((await redrive({ body: {} })).status).toBe(400);
    expect(state.procureCalls).toEqual([]);
  });
});

describe('adminRedriveOrderHandler — idempotency', () => {
  it('a same-key replay does NOT call procureOne a second time (double-click safety)', async () => {
    const first = await redrive();
    expect(first.status).toBe(200);
    expect(state.procureCalls).toHaveLength(1);

    // Simulate the second call hitting the stored snapshot — same
    // shape as the guard's real replay path.
    state.priorSnapshot = {
      status: 200,
      body: { result: { orderId: ORDER_ID, outcome: 'fulfilled', state: 'paid' }, audit: {} },
    };

    const second = await redrive();
    expect(second.status).toBe(200);
    // Still exactly one procureOne call across BOTH handler
    // invocations — the guard short-circuited the second doWrite().
    expect(state.procureCalls).toHaveLength(1);
    expect(state.discordCalls).toHaveLength(2); // audit fires on replay too (replayed: true)
  });

  it('replays mark audit.replayed and skip the Discord "fresh write" framing distinction only via the replayed flag', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: { orderId: ORDER_ID, outcome: 'fulfilled', state: 'paid' },
        audit: { replayed: false },
      },
    };
    const res = await redrive();
    expect(res.status).toBe(200);
    expect(state.procureCalls).toEqual([]); // no second procurement attempt
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });
});
