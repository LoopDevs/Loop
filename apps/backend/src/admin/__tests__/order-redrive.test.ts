/**
 * Admin order re-drive lever (A5-1), paid-only scope. This file covers
 * the HANDLER edge: state-eligibility routing (paid redrives,
 * procuring refused, terminal states refused), the outcome → status
 * mapping, the no-snapshot-on-failure contract, and same-key
 * idempotent replay.
 *
 * The money-safety property this handler *delegates to* (rather than
 * reimplements) is NOT re-tested here — it's `markOrderProcuring`'s
 * `WHERE state='paid'` CAS making concurrent `procureOne` calls
 * single-flight (one wins, the rest report `'skipped'` before reaching
 * `payCtxOrder`), proven in `orders/__tests__/procurement.test.ts`
 * ("another worker already claimed order → skipped, no CTX call") and
 * `orders/__tests__/pay-ctx.test.ts` (the `A4:` ctx_settlements
 * idempotency cases). What IS proven here: the handler calls
 * `procureOne` AT MOST ONCE per redrive, never calls it at all when a
 * guard trips, and a same-key double-click converges to one
 * `procureOne` call via the idempotency-guard replay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

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
      body: { reason: 'stuck paid order, worker looks dead, re-driving' },
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
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminRedriveOrderHandler — paid orders', () => {
  it('200: redrives a paid order directly via procureOne', async () => {
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ orderId: ORDER_ID, outcome: 'fulfilled', state: 'paid' });
    expect(state.procureCalls).toHaveLength(1);
    expect(state.procureCalls[0]?.id).toBe(ORDER_ID);
    expect(state.discordCalls).toHaveLength(1);
  });

  it('reports the fresh post-attempt state via a second read, not the pre-attempt one', async () => {
    // First getOrderById call (eligibility check) sees 'paid'; the
    // SECOND call (post-procureOne re-fetch) sees 'fulfilled' — proves
    // the handler reports the fresh re-read, not an assumption derived
    // from `outcome`.
    state.orderSequence = [makeOrder({ state: 'paid' }), makeOrder({ state: 'fulfilled' })];
    const res = await redrive();
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ orderId: ORDER_ID, outcome: 'fulfilled', state: 'fulfilled' });
  });

  it('outcome=skipped (another claimant won the CAS) still 200s with the real final state', async () => {
    // `procureOne` reports `skipped` when its own `markOrderProcuring`
    // CAS loses the claim to a live worker / another redrive (proven
    // independently in procurement.test.ts) — the handler surfaces that
    // faithfully rather than assuming success. The winning claimant
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

describe('adminRedriveOrderHandler — procuring orders are refused (paid-only scope)', () => {
  it('409 ORDER_REDRIVE_IN_PROGRESS — never calls procureOne, stores no snapshot', async () => {
    state.orders.set(ORDER_ID, makeOrder({ state: 'procuring', procuredAt: new Date() }));
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_IN_PROGRESS');
    expect(state.procureCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('refuses a long-stale procuring order the same way (no wall-clock exception)', async () => {
    // Even a very old procuring row is refused — the whole
    // revert-and-re-procure path is out of scope; the recovery sweep
    // owns stuck procuring orders.
    state.orders.set(
      ORDER_ID,
      makeOrder({ state: 'procuring', procuredAt: new Date(Date.now() - 60 * 60 * 1000) }),
    );
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORDER_REDRIVE_IN_PROGRESS');
    expect(state.procureCalls).toEqual([]);
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
    // Still exactly one procureOne call across BOTH handler invocations
    // — the guard short-circuited the second doWrite().
    expect(state.procureCalls).toHaveLength(1);
    expect(state.discordCalls).toHaveLength(2); // audit fires on replay too (replayed: true)
  });

  it('replays return the snapshot and mark the audit as replayed', async () => {
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
