import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as unknown,
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
    state: 'pending_payouts.state',
    assetCode: 'pending_payouts.asset_code',
    createdAt: 'pending_payouts.created_at',
    confirmedAt: 'pending_payouts.confirmed_at',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminSettlementLagHandler } from '../settlement-lag.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
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

describe('adminSettlementLagHandler', () => {
  it('returns empty rows when no confirmed payouts in window', async () => {
    const res = await adminSettlementLagHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('maps per-asset rows + the fleet-wide aggregate (asset_code: null)', async () => {
    state.rows = [
      {
        asset_code: null,
        sample_count: 180n,
        p50_s: '45.3',
        p95_s: '240.7',
        max_s: '1201.2',
        mean_s: '80.0',
      },
      {
        asset_code: 'USDLOOP',
        sample_count: 120n,
        p50_s: '44.9',
        p95_s: '220.1',
        max_s: '800.0',
        mean_s: '70.4',
      },
      {
        asset_code: 'GBPLOOP',
        sample_count: 60,
        p50_s: 50,
        p95_s: 260,
        max_s: 1201,
        mean_s: 100,
      },
    ];
    const res = await adminSettlementLagHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toEqual({
      assetCode: null,
      sampleCount: 180,
      p50Seconds: 45,
      p95Seconds: 241,
      maxSeconds: 1201,
      meanSeconds: 80,
    });
    expect(body.rows[1]!['assetCode']).toBe('USDLOOP');
    expect(body.rows[2]!['assetCode']).toBe('GBPLOOP');
  });

  it('coerces null percentiles to 0 (degenerate / empty buckets)', async () => {
    state.rows = [
      {
        asset_code: 'EURLOOP',
        sample_count: 1n,
        p50_s: null,
        p95_s: null,
        max_s: null,
        mean_s: null,
      },
    ];
    const res = await adminSettlementLagHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toEqual({
      assetCode: 'EURLOOP',
      sampleCount: 1,
      p50Seconds: 0,
      p95Seconds: 0,
      maxSeconds: 0,
      meanSeconds: 0,
    });
  });

  it('400 on malformed since', async () => {
    const res = await adminSettlementLagHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminSettlementLagHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('echoes ?since back in the response', async () => {
    const since = '2026-04-15T00:00:00Z';
    const res = await adminSettlementLagHandler(makeCtx({ since }));
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-04-15T00:00:00.000Z');
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          asset_code: 'USDLOOP',
          sample_count: 5,
          p50_s: 10,
          p95_s: 20,
          max_s: 30,
          mean_s: 15,
        },
      ],
    };
    const res = await adminSettlementLagHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['assetCode']).toBe('USDLOOP');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminSettlementLagHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
