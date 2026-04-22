import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * The merchants module exports two functions the handler calls:
 *   - refreshMerchants() — the mutex-guarded upstream sweep
 *   - getMerchants() — returns the in-memory store snapshot
 *
 * Tests drive both via `syncState` so the handler can observe a
 * before/after difference in `loadedAt` (the truthy path) or no
 * difference (the coalesced path, where another sync was already
 * in flight).
 */
const { syncState } = vi.hoisted(() => ({
  syncState: {
    storeLoadedAt: 1_000_000, // seed: pretend the app booted at this unix-ms
    storeCount: 100,
    refreshThrows: null as Error | null,
    refreshDidRun: false,
  },
}));

vi.mock('../../merchants/sync.js', () => ({
  refreshMerchants: vi.fn(async () => {
    if (syncState.refreshThrows !== null) throw syncState.refreshThrows;
    syncState.refreshDidRun = true;
    // Simulate the sweep advancing loadedAt + optionally changing count.
    syncState.storeLoadedAt = Date.now();
  }),
  getMerchants: () => ({
    merchants: Array.from({ length: syncState.storeCount }, (_, i) => ({ id: `m-${i}` })),
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: syncState.storeLoadedAt,
  }),
}));

import { adminMerchantsResyncHandler } from '../merchants-resync.js';

function makeCtx(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  syncState.storeLoadedAt = 1_000_000;
  syncState.storeCount = 100;
  syncState.refreshThrows = null;
  syncState.refreshDidRun = false;
});

describe('adminMerchantsResyncHandler', () => {
  it('returns the post-sync store snapshot with triggered=true when loadedAt advances', async () => {
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantCount: number;
      loadedAt: string;
      triggered: boolean;
    };
    expect(body.merchantCount).toBe(100);
    expect(body.triggered).toBe(true);
    // loadedAt is an ISO string — just check it's parseable.
    expect(() => new Date(body.loadedAt)).not.toThrow();
  });

  it('reports triggered=false when the sync coalesces with an in-flight run (loadedAt unchanged)', async () => {
    // Make refreshMerchants a no-op so storeLoadedAt doesn't advance;
    // mimics the mutex short-circuit path in the real module.
    const beforeAt = syncState.storeLoadedAt;
    syncState.refreshDidRun = false;
    const { refreshMerchants } = await import('../../merchants/sync.js');
    (
      refreshMerchants as unknown as { mockImplementationOnce: (fn: () => void) => void }
    ).mockImplementationOnce(async () => {
      /* coalesce → no-op, loadedAt stays */
    });
    const res = await adminMerchantsResyncHandler(makeCtx());
    const body = (await res.json()) as { triggered: boolean; loadedAt: string };
    expect(body.triggered).toBe(false);
    expect(new Date(body.loadedAt).getTime()).toBe(beforeAt);
  });

  it('502s when the upstream sweep throws (circuit-breaker open, network fail, etc.)', async () => {
    syncState.refreshThrows = new Error('upstream 503');
    const res = await adminMerchantsResyncHandler(makeCtx());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UPSTREAM_ERROR');
  });

  it('reflects the current merchant count in the response after sync', async () => {
    syncState.storeCount = 473;
    const res = await adminMerchantsResyncHandler(makeCtx());
    const body = (await res.json()) as { merchantCount: number };
    expect(body.merchantCount).toBe(473);
  });
});
