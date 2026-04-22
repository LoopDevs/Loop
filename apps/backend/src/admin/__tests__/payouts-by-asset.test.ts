import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    assetCode: 'pending_payouts.asset_code',
    state: 'pending_payouts.state',
    amountStroops: 'pending_payouts.amount_stroops',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminPayoutsByAssetHandler } from '../payouts-by-asset.js';

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
  state.rows = [];
  state.throwErr = null;
});

describe('adminPayoutsByAssetHandler', () => {
  it('returns empty rows when pending_payouts is empty', async () => {
    const res = await adminPayoutsByAssetHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('pivots (asset_code, state) rows into a per-asset breakdown', async () => {
    state.rows = [
      { asset_code: 'GBPLOOP', state: 'pending', count: '2', stroops: 50_000_000n },
      { asset_code: 'GBPLOOP', state: 'submitted', count: 1, stroops: '25000000' },
      { asset_code: 'GBPLOOP', state: 'confirmed', count: '10', stroops: 250_000_000n },
      { asset_code: 'USDLOOP', state: 'failed', count: '3', stroops: '75000000' },
    ];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      assetCode: 'GBPLOOP',
      pending: { count: 2, stroops: '50000000' },
      submitted: { count: 1, stroops: '25000000' },
      confirmed: { count: 10, stroops: '250000000' },
      failed: { count: 0, stroops: '0' },
    });
    expect(body.rows[1]).toEqual({
      assetCode: 'USDLOOP',
      pending: { count: 0, stroops: '0' },
      submitted: { count: 0, stroops: '0' },
      confirmed: { count: 0, stroops: '0' },
      failed: { count: 3, stroops: '75000000' },
    });
  });

  it('drops unknown states rather than spreading them into the response', async () => {
    state.rows = [
      { asset_code: 'GBPLOOP', state: 'rogue', count: '1', stroops: '99' },
      { asset_code: 'GBPLOOP', state: 'pending', count: '1', stroops: '100' },
    ];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]!['pending']).toEqual({ count: 1, stroops: '100' });
    // No key for "rogue" — the handler dropped it.
    expect(body.rows[0]!).not.toHaveProperty('rogue');
  });

  it('sorts assets alphabetically', async () => {
    state.rows = [
      { asset_code: 'USDLOOP', state: 'pending', count: '1', stroops: '1' },
      { asset_code: 'EURLOOP', state: 'pending', count: '1', stroops: '1' },
      { asset_code: 'GBPLOOP', state: 'pending', count: '1', stroops: '1' },
    ];
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ assetCode: string }>;
    };
    expect(body.rows.map((r) => r.assetCode)).toEqual(['EURLOOP', 'GBPLOOP', 'USDLOOP']);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [{ asset_code: 'GBPLOOP', state: 'pending', count: 1, stroops: 10n }],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminPayoutsByAssetHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['assetCode']).toBe('GBPLOOP');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPayoutsByAssetHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
