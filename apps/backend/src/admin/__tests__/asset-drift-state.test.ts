import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { mock } = vi.hoisted(() => ({
  mock: {
    state: {
      lastTickMs: null as number | null,
      running: false,
      perAsset: [] as Array<{
        assetCode: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
        state: 'unknown' | 'ok' | 'over';
        lastDriftStroops: bigint | null;
        lastThresholdStroops: bigint | null;
        lastCheckedMs: number | null;
      }>,
    },
  },
}));

vi.mock('../../payments/asset-drift-watcher.js', () => ({
  getAssetDriftState: () => mock.state,
}));

import { adminAssetDriftStateHandler } from '../asset-drift-state.js';

function fakeContext(): Context {
  const captured: { status: number; body: unknown } = { status: 0, body: null };
  const c = {
    json: (body: unknown, status?: number) => {
      captured.status = status ?? 200;
      captured.body = body;
      return new Response(JSON.stringify(body), {
        status: captured.status,
        headers: { 'content-type': 'application/json' },
      });
    },
    _captured: captured,
  };
  return c as unknown as Context;
}

beforeEach(() => {
  mock.state.lastTickMs = null;
  mock.state.running = false;
  mock.state.perAsset = [];
});

describe('adminAssetDriftStateHandler', () => {
  it('returns `running: false` and an empty per-asset list when the watcher never ran', async () => {
    mock.state.running = false;
    const c = fakeContext();
    const res = adminAssetDriftStateHandler(c);
    const body = (await res.json()) as {
      lastTickMs: number | null;
      running: boolean;
      perAsset: unknown[];
    };
    expect(res.status).toBe(200);
    expect(body.lastTickMs).toBeNull();
    expect(body.running).toBe(false);
    expect(body.perAsset).toEqual([]);
  });

  it('serialises bigint drift / threshold as strings', async () => {
    mock.state.lastTickMs = 1_700_000_000_000;
    mock.state.running = true;
    mock.state.perAsset = [
      {
        assetCode: 'USDLOOP',
        state: 'over',
        lastDriftStroops: 12_345_678_900n,
        lastThresholdStroops: 100_000_000n,
        lastCheckedMs: 1_700_000_000_000,
      },
    ];
    const c = fakeContext();
    const res = adminAssetDriftStateHandler(c);
    const body = (await res.json()) as {
      running: boolean;
      perAsset: Array<{
        assetCode: string;
        state: string;
        lastDriftStroops: string | null;
        lastThresholdStroops: string | null;
      }>;
    };
    expect(body.running).toBe(true);
    expect(body.perAsset[0]).toEqual({
      assetCode: 'USDLOOP',
      state: 'over',
      lastDriftStroops: '12345678900',
      lastThresholdStroops: '100000000',
      lastCheckedMs: 1_700_000_000_000,
    });
  });

  it('preserves null drift values (pre-first-tick rows) without coercing to "0"', async () => {
    mock.state.running = true;
    mock.state.perAsset = [
      {
        assetCode: 'GBPLOOP',
        state: 'unknown',
        lastDriftStroops: null,
        lastThresholdStroops: null,
        lastCheckedMs: null,
      },
    ];
    const c = fakeContext();
    const res = adminAssetDriftStateHandler(c);
    const body = (await res.json()) as {
      perAsset: Array<{ lastDriftStroops: string | null; lastCheckedMs: number | null }>;
    };
    expect(body.perAsset[0]!.lastDriftStroops).toBeNull();
    expect(body.perAsset[0]!.lastCheckedMs).toBeNull();
  });
});
