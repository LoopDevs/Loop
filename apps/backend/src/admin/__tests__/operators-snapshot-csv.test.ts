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

import { adminOperatorsSnapshotCsvHandler } from '../operators-snapshot-csv.js';

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

describe('adminOperatorsSnapshotCsvHandler', () => {
  it('returns just the header row when the DB returns nothing', async () => {
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    expect(body).toBe(
      'operator_id,order_count,fulfilled_count,failed_count,success_pct,sample_count,p50_ms,p95_ms,p99_ms,mean_ms,last_order_at\r\n',
    );
  });

  it('emits a Content-Disposition with a stable .csv filename', async () => {
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment; filename="operators-snapshot-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('maps a joined row with rounded percentiles + success %', async () => {
    state.rows = [
      {
        operator_id: 'op-alpha-01',
        order_count: 50n,
        fulfilled_count: 48,
        failed_count: '2',
        sample_count: 48n,
        p50_ms: '1450.6',
        p95_ms: 8200,
        p99_ms: '19500.9',
        mean_ms: '3100.3',
        last_order_at: '2026-04-22T10:00:00.000Z',
      },
    ];
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    const body = await res.text();
    const line = body.split('\r\n')[1];
    expect(line).toBe('op-alpha-01,50,48,2,96.0,48,1451,8200,19501,3100,2026-04-22T10:00:00.000Z');
  });

  it('null latency → zero-filled latency columns + empty success % for zero-order row', async () => {
    state.rows = [
      {
        operator_id: 'op-idle',
        order_count: 0n,
        fulfilled_count: 0n,
        failed_count: 0n,
        sample_count: null,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
        mean_ms: null,
        last_order_at: null,
      },
    ];
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    const body = await res.text();
    const line = body.split('\r\n')[1];
    expect(line).toBe('op-idle,0,0,0,,0,0,0,0,0,');
  });

  it('accepts ?since and 400s on malformed / out-of-window', async () => {
    const ok = await adminOperatorsSnapshotCsvHandler(makeCtx({ since: '2026-04-15T00:00:00Z' }));
    expect(ok.status).toBe(200);

    const bad = await adminOperatorsSnapshotCsvHandler(makeCtx({ since: 'nope' }));
    expect(bad.status).toBe(400);

    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const tooOldRes = await adminOperatorsSnapshotCsvHandler(makeCtx({ since: tooOld }));
    expect(tooOldRes.status).toBe(400);
  });

  it('appends __TRUNCATED__ sentinel on cap overflow', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      operator_id: `op-${i}`,
      order_count: 1n,
      fulfilled_count: 1n,
      failed_count: 0n,
      sample_count: 1n,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      mean_ms: 0,
      last_order_at: '2026-04-22T10:00:00.000Z',
    }));
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('\r\n__TRUNCATED__\r\n');
  });

  it('500s when the DB throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorsSnapshotCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
