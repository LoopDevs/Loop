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
  orders: {
    state: 'orders.state',
    ctxOperatorId: 'orders.ctx_operator_id',
    paidAt: 'orders.paid_at',
    fulfilledAt: 'orders.fulfilled_at',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminOperatorLatencyHandler } from '../operator-latency.js';

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

describe('adminOperatorLatencyHandler', () => {
  it('returns empty rows when no fulfilled orders in window', async () => {
    const res = await adminOperatorLatencyHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('maps aggregate rows and rounds percentiles to whole ms', async () => {
    state.rows = [
      {
        operator_id: 'op-alpha-01',
        sample_count: 120n,
        p50_ms: '1450.6',
        p95_ms: '8200.2',
        p99_ms: '19500.9',
        mean_ms: '3100.3',
      },
      {
        operator_id: 'op-beta-02',
        sample_count: 42,
        p50_ms: 900,
        p95_ms: 2200,
        p99_ms: 4100,
        mean_ms: 1120,
      },
    ];
    const res = await adminOperatorLatencyHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toEqual([
      {
        operatorId: 'op-alpha-01',
        sampleCount: 120,
        p50Ms: 1451,
        p95Ms: 8200,
        p99Ms: 19501,
        meanMs: 3100,
      },
      {
        operatorId: 'op-beta-02',
        sampleCount: 42,
        p50Ms: 900,
        p95Ms: 2200,
        p99Ms: 4100,
        meanMs: 1120,
      },
    ]);
  });

  it('coerces null percentiles to 0 (single-sample / degenerate rows)', async () => {
    state.rows = [
      {
        operator_id: 'op-solo',
        sample_count: 1n,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        mean_ms: null,
      },
    ];
    const res = await adminOperatorLatencyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toEqual({
      operatorId: 'op-solo',
      sampleCount: 1,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      meanMs: 0,
    });
  });

  it('accepts ?since and echoes it back', async () => {
    const since = '2026-04-15T00:00:00Z';
    const res = await adminOperatorLatencyHandler(makeCtx({ since }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-04-15T00:00:00.000Z');
  });

  it('400 on malformed since', async () => {
    const res = await adminOperatorLatencyHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminOperatorLatencyHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          operator_id: 'op-env',
          sample_count: 5,
          p50_ms: 1000,
          p95_ms: 2000,
          p99_ms: 3000,
          mean_ms: 1200,
        },
      ],
    };
    const res = await adminOperatorLatencyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['operatorId']).toBe('op-env');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorLatencyHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
