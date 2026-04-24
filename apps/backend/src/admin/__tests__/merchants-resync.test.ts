import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { syncMock, discordMock } = vi.hoisted(() => {
  const syncMock = {
    forceRefreshMerchants: vi.fn(async () => ({ triggered: true })),
    storeSnapshot: { merchants: [], loadedAt: 0 } as {
      merchants: Array<{ id: string }>;
      loadedAt: number;
    },
  };
  const discordMock = { notifyAdminAudit: vi.fn() };
  return { syncMock, discordMock };
});

vi.mock('../../merchants/sync.js', () => ({
  forceRefreshMerchants: syncMock.forceRefreshMerchants,
  getMerchants: () => syncMock.storeSnapshot,
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: (args: unknown) => discordMock.notifyAdminAudit(args),
}));

// A2-509: handler now routes through withIdempotencyGuard. Mock it to
// just call doWrite and return the snapshot — existing sync mocks
// still drive the refresh path.
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

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminMerchantsResyncHandler } from '../merchants-resync.js';

const VALID_KEY = 'k'.repeat(32);
const ADMIN = { id: 'admin-uuid', email: 'a@loop.test' };

function makeCtx(opts: { headers?: Record<string, string>; body?: unknown } = {}): Context {
  const headers = opts.headers ?? { 'idempotency-key': VALID_KEY };
  const store = new Map<string, unknown>([['user', ADMIN]]);
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
      header: (k: string) => headers[k.toLowerCase()],
      json: async () => opts.body ?? { reason: 'manual catalog refresh' },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  syncMock.forceRefreshMerchants.mockReset();
  syncMock.forceRefreshMerchants.mockResolvedValue({ triggered: true });
  syncMock.storeSnapshot = { merchants: [], loadedAt: 0 };
  discordMock.notifyAdminAudit.mockReset();
});

describe('adminMerchantsResyncHandler', () => {
  it('reports triggered: true + the post-sync snapshot on a primary sweep', async () => {
    syncMock.storeSnapshot = {
      merchants: new Array(473).fill(0).map((_, i) => ({ id: `m-${i}` })),
      loadedAt: Date.parse('2026-04-22T14:00:00.000Z'),
    };
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).toEqual({
      merchantCount: 473,
      loadedAt: '2026-04-22T14:00:00.000Z',
      triggered: true,
    });
  });

  it('reports triggered: false when another sweep was already in flight', async () => {
    syncMock.forceRefreshMerchants.mockResolvedValue({ triggered: false });
    syncMock.storeSnapshot = {
      merchants: [{ id: 'm-1' }],
      loadedAt: Date.parse('2026-04-22T14:00:00.000Z'),
    };
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result['triggered']).toBe(false);
    expect(body.result['merchantCount']).toBe(1);
  });

  it('502 UPSTREAM_ERROR when the sweep rethrows', async () => {
    syncMock.forceRefreshMerchants.mockRejectedValue(new Error('CTX 503'));
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('UPSTREAM_ERROR');
  });

  it('serialises loadedAt as ISO-8601 string', async () => {
    syncMock.storeSnapshot = {
      merchants: [],
      loadedAt: Date.parse('2026-04-22T14:05:30.250Z'),
    };
    const res = await adminMerchantsResyncHandler(makeCtx());
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result['loadedAt']).toBe('2026-04-22T14:05:30.250Z');
  });

  // A2-509: ADR-017 admin-write contract.
  it('A2-509: 400 IDEMPOTENCY_KEY_REQUIRED when the header is missing', async () => {
    const res = await adminMerchantsResyncHandler(makeCtx({ headers: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('A2-509: 400 when the body omits reason', async () => {
    const res = await adminMerchantsResyncHandler(makeCtx({ body: {} }));
    expect(res.status).toBe(400);
  });

  it('A2-509: response is wrapped in the ADR-017 {result, audit} envelope', async () => {
    syncMock.storeSnapshot = { merchants: [], loadedAt: 0 };
    const res = await adminMerchantsResyncHandler(makeCtx());
    const body = (await res.json()) as {
      result: unknown;
      audit: { actorUserId: string; idempotencyKey: string; replayed: boolean };
    };
    expect(body.audit).toMatchObject({
      actorUserId: ADMIN.id,
      idempotencyKey: VALID_KEY,
      replayed: false,
    });
  });

  it('A2-509: notifyAdminAudit fires with reason + replayed flag', async () => {
    await adminMerchantsResyncHandler(makeCtx());
    expect(discordMock.notifyAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ADMIN.id,
        endpoint: 'POST /api/admin/merchants/resync',
        reason: 'manual catalog refresh',
        idempotencyKey: VALID_KEY,
        replayed: false,
      }),
    );
  });
});
