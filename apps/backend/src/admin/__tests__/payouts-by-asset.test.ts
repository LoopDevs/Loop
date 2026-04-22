import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[] | { rows: unknown[] }, throw: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'] as const,
  pendingPayouts: {
    assetCode: 'asset_code',
    state: 'state',
    amountStroops: 'amount_stroops',
  },
}));

import { adminPayoutsByAssetHandler } from '../payouts-by-asset.js';

function makeCtx(): Context {
  return {
    req: {},
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  execState.rows = [];
  execState.throw = false;
});

describe('adminPayoutsByAssetHandler', () => {
  it('happy path — per-asset zero-filled state map, non-zeros populated', async () => {
    execState.rows = [
      { assetCode: 'USDLOOP', state: 'pending', count: 3, stroops: 150_000_000n },
      { assetCode: 'USDLOOP', state: 'confirmed', count: 42, stroops: 2_000_000_000n },
      { assetCode: 'GBPLOOP', state: 'pending', count: 1, stroops: 50_000_000n },
    ];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      byAsset: Record<string, Record<string, { count: number; stroops: string }>>;
    };
    expect(Object.keys(body.byAsset).sort()).toEqual(['GBPLOOP', 'USDLOOP']);
    expect(body.byAsset.USDLOOP?.pending).toEqual({ count: 3, stroops: '150000000' });
    expect(body.byAsset.USDLOOP?.confirmed).toEqual({ count: 42, stroops: '2000000000' });
    // States that didn't appear for USDLOOP zero-fill.
    expect(body.byAsset.USDLOOP?.submitted).toEqual({ count: 0, stroops: '0' });
    expect(body.byAsset.USDLOOP?.failed).toEqual({ count: 0, stroops: '0' });
    // GBPLOOP got only one non-zero state.
    expect(body.byAsset.GBPLOOP?.pending?.count).toBe(1);
    expect(body.byAsset.GBPLOOP?.submitted?.count).toBe(0);
  });

  it('returns empty byAsset when the table is empty', async () => {
    execState.rows = [];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as { byAsset: Record<string, unknown> };
    expect(body.byAsset).toEqual({});
  });

  it('ignores unknown state values (defensive)', async () => {
    execState.rows = [
      { assetCode: 'USDLOOP', state: 'ghost', count: 99, stroops: 1n },
      { assetCode: 'USDLOOP', state: 'pending', count: 1, stroops: 10n },
    ];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as {
      byAsset: Record<string, Record<string, { count: number }>>;
    };
    // Only the valid 'pending' row populates; the 'ghost' row is ignored
    // but the asset still shows up because it had at least one valid row.
    expect(body.byAsset.USDLOOP?.pending?.count).toBe(1);
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [{ assetCode: 'EURLOOP', state: 'pending', count: 1, stroops: 100n }],
    };
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as {
      byAsset: Record<string, Record<string, { count: number }>>;
    };
    expect(body.byAsset.EURLOOP?.pending?.count).toBe(1);
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminPayoutsByAssetHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
