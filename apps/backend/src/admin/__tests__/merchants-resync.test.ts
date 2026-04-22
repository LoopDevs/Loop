import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { syncMock } = vi.hoisted(() => {
  const syncMock = {
    forceRefreshMerchants: vi.fn(async () => ({ triggered: true })),
    storeSnapshot: { merchants: [], loadedAt: 0 } as {
      merchants: Array<{ id: string }>;
      loadedAt: number;
    },
  };
  return { syncMock };
});

vi.mock('../../merchants/sync.js', () => ({
  forceRefreshMerchants: syncMock.forceRefreshMerchants,
  getMerchants: () => syncMock.storeSnapshot,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminMerchantsResyncHandler } from '../merchants-resync.js';

function makeCtx(): Context {
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
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
});

describe('adminMerchantsResyncHandler', () => {
  it('reports triggered: true + the post-sync snapshot on a primary sweep', async () => {
    syncMock.storeSnapshot = {
      merchants: new Array(473).fill(0).map((_, i) => ({ id: `m-${i}` })),
      loadedAt: Date.parse('2026-04-22T14:00:00.000Z'),
    };
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['triggered']).toBe(false);
    // The merchant snapshot still reports the in-flight sweep's
    // loadedAt once it completes — coalesced callers see the same
    // final state as the primary.
    expect(body['merchantCount']).toBe(1);
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['loadedAt']).toBe('2026-04-22T14:05:30.250Z');
  });
});
