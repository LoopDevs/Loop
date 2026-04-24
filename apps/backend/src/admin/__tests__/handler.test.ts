import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

// vi.mock is hoisted above imports, so anything referenced inside
// the factory must come from vi.hoisted or be inlined.
const { dbMock, insertedRow, preEditRow, notifyMock } = vi.hoisted(() => {
  const state = { out: null as unknown };
  const preEdit = { value: undefined as unknown };
  // Chainable query-builder mock — each method returns `this` so
  // the handler's fluent chains resolve without touching a real pg.
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['orderBy'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => [] as unknown[]);
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn(() => m);
  m['onConflictDoUpdate'] = vi.fn(() => m);
  m['returning'] = vi.fn(async () => [state.out]);
  // db.query.merchantCashbackConfigs.findFirst — pre-edit snapshot
  // read for the Discord audit diff. Attached as a non-fn entry on
  // the same object; the test harness reaches it via `dbMock.query`.
  // Cast through `unknown` so the sibling-fn record type stays
  // tight for `mockClear` / `mockImplementationOnce` callers below.
  (m as unknown as Record<string, unknown>)['query'] = {
    merchantCashbackConfigs: {
      findFirst: vi.fn(async () => preEdit.value),
    },
  };
  return {
    dbMock: m,
    insertedRow: state,
    preEditRow: preEdit,
    notifyMock: vi.fn(),
  };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: { merchantId: 'merchantId' },
  merchantCashbackConfigHistory: {
    merchantId: 'merchantId',
    changedAt: 'changedAt',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
  };
});

const { notifyAdminAuditMock } = vi.hoisted(() => ({ notifyAdminAuditMock: vi.fn() }));

vi.mock('../../discord.js', () => ({
  notifyCashbackConfigChanged: (args: unknown) => notifyMock(args),
  notifyAdminAudit: (args: unknown) => notifyAdminAuditMock(args),
}));

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({
    merchantsById: new Map([['m-1', { id: 'm-1', name: 'Test Merchant' }]]),
  }),
}));

// A2-502: upsertConfigHandler now routes writes through
// withIdempotencyGuard. Mock it to just call the inner doWrite and
// return the resulting snapshot, so the existing DB mocks for
// insert/update still drive the write path.
vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: { adminUserId: string; key: string; method: string; path: string },
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      const { status, body } = await doWrite();
      return { replayed: false, status, body };
    },
  ),
}));

import { listConfigsHandler, upsertConfigHandler, configHistoryHandler } from '../handler.js';

interface FakeCtx {
  param: Record<string, string | undefined>;
  body: unknown;
  user: { id: string };
  ctx: Context;
}

function makeCtx(opts: {
  param?: Record<string, string | undefined>;
  body?: unknown;
  user?: { id: string; email?: string };
  /** Idempotency-Key header value. Leave undefined to omit. */
  idempotencyKey?: string;
}): FakeCtx {
  const store = new Map<string, unknown>();
  const user = opts.user ?? { id: 'admin-uuid', email: 'a@loop.test' };
  store.set('user', user);
  const headers: Record<string, string | undefined> = {
    'idempotency-key': opts.idempotencyKey,
  };
  const fake: FakeCtx = {
    param: opts.param ?? {},
    body: opts.body,
    user,
    ctx: {
      req: {
        param: (k: string) => fake.param[k],
        header: (k: string) => headers[k.toLowerCase()],
        json: async () => {
          if (opts.body === '__throw__') throw new Error('bad json');
          return opts.body;
        },
      },
      get: (k: string) => store.get(k),
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
  return fake;
}

// A valid 32-char idempotency key for ADR-017 admin writes.
const VALID_KEY = 'a'.repeat(32);

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  insertedRow.out = null;
  preEditRow.value = undefined;
  notifyMock.mockClear();
  notifyAdminAuditMock.mockClear();
});

describe('listConfigsHandler', () => {
  it('returns the configs in an envelope', async () => {
    // Handler awaits the result of `.orderBy(...)`. Make orderBy a
    // thenable that resolves to the desired rows for this test.
    const rows = [{ merchantId: 'm1' }, { merchantId: 'm2' }];
    dbMock['orderBy']!.mockImplementationOnce(
      () => Promise.resolve(rows) as unknown as typeof dbMock,
    );
    const { ctx } = makeCtx({});
    const res = await listConfigsHandler(ctx);
    const body = (await res.json()) as { configs: unknown[] };
    expect(res.status).toBe(200);
    expect(body.configs).toEqual(rows);
  });
});

describe('upsertConfigHandler', () => {
  const GOOD_BODY = {
    wholesalePct: 70,
    userCashbackPct: 20,
    loopMarginPct: 10,
    reason: 'tuning merchant split',
  };
  const ROW = {
    merchantId: 'm1',
    wholesalePct: '70.00',
    userCashbackPct: '20.00',
    loopMarginPct: '10.00',
    active: true,
    updatedBy: 'admin-uuid',
    updatedAt: new Date('2026-04-24T00:00:00Z'),
  };

  it('400 when merchantId param is missing', async () => {
    const { ctx } = makeCtx({ param: { merchantId: undefined }, idempotencyKey: VALID_KEY });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  // A2-513: match the shape check used by sibling per-merchant admin
  // handlers — reject malformed ids before they hit the DB.
  it('A2-513: 400 on a merchantId with unsupported characters', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'bad id with spaces' },
      body: GOOD_BODY,
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/malformed/);
  });

  it('A2-513: 400 on a merchantId longer than 128 chars', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'a'.repeat(129) },
      body: GOOD_BODY,
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  // A2-502: ADR-017 compliance — Idempotency-Key header required.
  it('A2-502: 400 IDEMPOTENCY_KEY_REQUIRED when the header is missing', async () => {
    const { ctx } = makeCtx({ param: { merchantId: 'm1' }, body: GOOD_BODY });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('A2-502: 400 IDEMPOTENCY_KEY_REQUIRED when the header is too short', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: GOOD_BODY,
      idempotencyKey: 'short',
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  // A2-502: ADR-017 compliance — `reason` is now a required body field.
  it('A2-502: 400 when the body omits reason', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 70, userCashbackPct: 20, loopMarginPct: 10 },
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the body is not valid JSON', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: '__throw__',
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the body fails zod validation (out-of-range percent)', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 101, userCashbackPct: 0, loopMarginPct: 0, reason: 'bad' },
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the three pcts sum to more than 100', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 60, userCashbackPct: 30, loopMarginPct: 20, reason: 'over' },
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/≤ 100|<= 100/);
  });

  it('A2-502: upserts and returns the ADR-017 {result, audit} envelope', async () => {
    insertedRow.out = ROW;
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: GOOD_BODY,
      user: { id: 'admin-uuid', email: 'a@loop.test' },
      idempotencyKey: VALID_KEY,
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { merchantId: string; wholesalePct: string };
      audit: { actorUserId: string; idempotencyKey: string; replayed: boolean };
    };
    expect(body.result).toMatchObject({ merchantId: 'm1', wholesalePct: '70.00' });
    expect(body.audit).toMatchObject({
      actorUserId: 'admin-uuid',
      idempotencyKey: VALID_KEY,
      replayed: false,
    });
    // Values handed to drizzle use fixed(2) strings — verify.
    expect(dbMock['values']!).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'm1',
        wholesalePct: '70.00',
        userCashbackPct: '20.00',
        loopMarginPct: '10.00',
        active: true,
        updatedBy: 'admin-uuid',
      }),
    );
  });

  it('defaults active to true when omitted from the body', async () => {
    insertedRow.out = { ...ROW, merchantId: 'm2' };
    const { ctx } = makeCtx({
      param: { merchantId: 'm2' },
      body: { ...GOOD_BODY, wholesalePct: 10, userCashbackPct: 10, loopMarginPct: 10 },
      user: { id: 'admin-uuid' },
      idempotencyKey: VALID_KEY,
    });
    await upsertConfigHandler(ctx);
    expect((dbMock['values'] as ReturnType<typeof vi.fn>)!).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
  });

  it('fires notifyCashbackConfigChanged with previous=null on first-time create', async () => {
    preEditRow.value = undefined;
    insertedRow.out = {
      ...ROW,
      merchantId: 'm-1',
      wholesalePct: '70.00',
      userCashbackPct: '25.00',
      loopMarginPct: '5.00',
    };
    const { ctx } = makeCtx({
      param: { merchantId: 'm-1' },
      body: { wholesalePct: 70, userCashbackPct: 25, loopMarginPct: 5, reason: 'first-time' },
      user: { id: 'admin-uuid' },
      idempotencyKey: VALID_KEY,
    });
    await upsertConfigHandler(ctx);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'm-1',
        merchantName: 'Test Merchant',
        actorUserId: 'admin-uuid',
        previous: null,
        next: expect.objectContaining({
          wholesalePct: '70.00',
          userCashbackPct: '25.00',
          loopMarginPct: '5.00',
          active: true,
        }),
      }),
    );
  });

  it('fires notifyCashbackConfigChanged with an old → new diff on update', async () => {
    preEditRow.value = {
      merchantId: 'm-1',
      wholesalePct: '80.00',
      userCashbackPct: '15.00',
      loopMarginPct: '5.00',
      active: true,
    };
    insertedRow.out = {
      ...ROW,
      merchantId: 'm-1',
      wholesalePct: '75.00',
      userCashbackPct: '18.00',
      loopMarginPct: '7.00',
    };
    const { ctx } = makeCtx({
      param: { merchantId: 'm-1' },
      body: { wholesalePct: 75, userCashbackPct: 18, loopMarginPct: 7, reason: 'retune' },
      user: { id: 'admin-uuid' },
      idempotencyKey: VALID_KEY,
    });
    await upsertConfigHandler(ctx);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['previous']).toEqual({
      wholesalePct: '80.00',
      userCashbackPct: '15.00',
      loopMarginPct: '5.00',
      active: true,
    });
    expect(call['next']).toEqual({
      wholesalePct: '75.00',
      userCashbackPct: '18.00',
      loopMarginPct: '7.00',
      active: true,
    });
  });

  // A2-502: the generic admin-audit channel gets a fanout per ADR 017 #5.
  it('A2-502: fires notifyAdminAudit with actor + reason + replayed=false', async () => {
    insertedRow.out = ROW;
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: GOOD_BODY,
      user: { id: 'admin-uuid' },
      idempotencyKey: VALID_KEY,
    });
    await upsertConfigHandler(ctx);
    expect(notifyAdminAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin-uuid',
        endpoint: 'PUT /api/admin/merchant-cashback-configs/m1',
        reason: GOOD_BODY.reason,
        idempotencyKey: VALID_KEY,
        replayed: false,
      }),
    );
  });

  it('falls back to merchantId as the Discord merchantName when the catalog has evicted the row (Rule A)', async () => {
    preEditRow.value = undefined;
    insertedRow.out = {
      ...ROW,
      merchantId: 'ghost',
      wholesalePct: '70.00',
      userCashbackPct: '25.00',
      loopMarginPct: '5.00',
    };
    const { ctx } = makeCtx({
      param: { merchantId: 'ghost' },
      body: { wholesalePct: 70, userCashbackPct: 25, loopMarginPct: 5, reason: 'ghost edit' },
      user: { id: 'admin-uuid' },
      idempotencyKey: VALID_KEY,
    });
    await upsertConfigHandler(ctx);
    const call = notifyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['merchantName']).toBe('ghost');
  });
});

describe('configHistoryHandler — A2-513 validation', () => {
  it('400 when merchantId param is missing', async () => {
    const { ctx } = makeCtx({ param: { merchantId: undefined } });
    const res = await configHistoryHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 on a merchantId with unsupported characters', async () => {
    const { ctx } = makeCtx({ param: { merchantId: 'bad/id' } });
    const res = await configHistoryHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/malformed/);
  });

  it('400 on a merchantId longer than 128 chars', async () => {
    const { ctx } = makeCtx({ param: { merchantId: 'a'.repeat(129) } });
    const res = await configHistoryHandler(ctx);
    expect(res.status).toBe(400);
  });
});

describe('configHistoryHandler', () => {
  it('400 when merchantId param is missing', async () => {
    const { ctx } = makeCtx({ param: { merchantId: undefined } });
    const res = await configHistoryHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('returns the history rows in an envelope', async () => {
    const rows = [{ merchantId: 'm1', changedAt: '2025-01-01T00:00:00Z' }];
    dbMock['limit']!.mockResolvedValueOnce(rows);
    const { ctx } = makeCtx({ param: { merchantId: 'm1' } });
    const res = await configHistoryHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toEqual(rows);
  });
});
