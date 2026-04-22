import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

// vi.mock is hoisted above imports, so anything referenced inside
// the factory must come from vi.hoisted or be inlined.
const { dbMock, insertedRow, findFirstState } = vi.hoisted(() => {
  const state = { out: null as unknown };
  const findFirst = { result: undefined as unknown };
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
  return { dbMock: m, insertedRow: state, findFirstState: findFirst };
});

vi.mock('../../db/client.js', () => ({
  db: {
    ...dbMock,
    query: {
      merchantCashbackConfigs: {
        findFirst: vi.fn(async () => findFirstState.result),
      },
    },
  },
}));
vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: { merchantId: 'merchantId' },
  merchantCashbackConfigHistory: {
    merchantId: 'merchantId',
    changedAt: 'changedAt',
  },
}));

const { merchantState, discordMock } = vi.hoisted(() => ({
  merchantState: { byId: new Map<string, { name: string }>() },
  discordMock: { notifyCashbackConfigChanged: vi.fn() },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));
vi.mock('../../discord.js', () => ({
  notifyCashbackConfigChanged: discordMock.notifyCashbackConfigChanged,
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
  user?: { id: string };
}): FakeCtx {
  const store = new Map<string, unknown>();
  const user = opts.user ?? { id: 'admin-uuid' };
  store.set('user', user);
  const fake: FakeCtx = {
    param: opts.param ?? {},
    body: opts.body,
    user,
    ctx: {
      req: {
        param: (k: string) => fake.param[k],
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

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  insertedRow.out = null;
  findFirstState.result = undefined;
  merchantState.byId = new Map();
  discordMock.notifyCashbackConfigChanged.mockClear();
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
  it('400 when merchantId param is missing', async () => {
    const { ctx } = makeCtx({ param: { merchantId: undefined } });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the body is not valid JSON', async () => {
    const { ctx } = makeCtx({ param: { merchantId: 'm1' }, body: '__throw__' });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the body fails zod validation (out-of-range percent)', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 101, userCashbackPct: 0, loopMarginPct: 0 },
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
  });

  it('400 when the three pcts sum to more than 100', async () => {
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 60, userCashbackPct: 30, loopMarginPct: 20 },
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/≤ 100|<= 100/);
  });

  it('upserts and returns the row on a valid body', async () => {
    insertedRow.out = {
      merchantId: 'm1',
      wholesalePct: '70.00',
      userCashbackPct: '20.00',
      loopMarginPct: '10.00',
      active: true,
      updatedBy: 'admin-uuid',
    };
    const { ctx } = makeCtx({
      param: { merchantId: 'm1' },
      body: { wholesalePct: 70, userCashbackPct: 20, loopMarginPct: 10 },
      user: { id: 'admin-uuid' },
    });
    const res = await upsertConfigHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { wholesalePct: string } };
    expect(body.config.wholesalePct).toBe('70.00');
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
    insertedRow.out = { merchantId: 'm2' };
    const { ctx } = makeCtx({
      param: { merchantId: 'm2' },
      body: { wholesalePct: 10, userCashbackPct: 10, loopMarginPct: 10 },
      user: { id: 'admin-uuid' },
    });
    await upsertConfigHandler(ctx);
    expect(dbMock['values']!).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
  });

  it('fires Discord signal with previous=null on first-time insert', async () => {
    insertedRow.out = { merchantId: 'm-new' };
    findFirstState.result = undefined;
    merchantState.byId = new Map([['m-new', { name: 'NewMerchant' }]]);
    const { ctx } = makeCtx({
      param: { merchantId: 'm-new' },
      body: { wholesalePct: 80, userCashbackPct: 15, loopMarginPct: 5 },
      user: { id: 'admin-uuid-1' },
    });
    await upsertConfigHandler(ctx);
    expect(discordMock.notifyCashbackConfigChanged).toHaveBeenCalledTimes(1);
    expect(discordMock.notifyCashbackConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'm-new',
        merchantName: 'NewMerchant',
        adminId: 'admin-uuid-1',
        previous: null,
        next: {
          wholesalePct: '80.00',
          userCashbackPct: '15.00',
          loopMarginPct: '5.00',
          active: true,
        },
      }),
    );
  });

  it('fires Discord signal with previous diff on update', async () => {
    insertedRow.out = { merchantId: 'm-exists' };
    findFirstState.result = {
      merchantId: 'm-exists',
      wholesalePct: '70.00',
      userCashbackPct: '20.00',
      loopMarginPct: '10.00',
      active: true,
    };
    merchantState.byId = new Map([['m-exists', { name: 'Amazon' }]]);
    const { ctx } = makeCtx({
      param: { merchantId: 'm-exists' },
      body: { wholesalePct: 75, userCashbackPct: 18, loopMarginPct: 7 },
      user: { id: 'admin-uuid-2' },
    });
    await upsertConfigHandler(ctx);
    expect(discordMock.notifyCashbackConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantName: 'Amazon',
        previous: {
          wholesalePct: '70.00',
          userCashbackPct: '20.00',
          loopMarginPct: '10.00',
          active: true,
        },
        next: {
          wholesalePct: '75.00',
          userCashbackPct: '18.00',
          loopMarginPct: '7.00',
          active: true,
        },
      }),
    );
  });

  it('falls back to merchantId when the catalog is missing the entry', async () => {
    insertedRow.out = { merchantId: 'm-ghost' };
    findFirstState.result = undefined;
    merchantState.byId = new Map(); // empty catalog
    const { ctx } = makeCtx({
      param: { merchantId: 'm-ghost' },
      body: { wholesalePct: 50, userCashbackPct: 10, loopMarginPct: 10 },
      user: { id: 'admin-uuid' },
    });
    await upsertConfigHandler(ctx);
    expect(discordMock.notifyCashbackConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({ merchantName: 'm-ghost' }),
    );
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
