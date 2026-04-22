import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  limitArg: 0,
}));

const limitMock = vi.fn(async (n: number) => {
  state.limitArg = n;
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    createdAt: 'pending_payouts.created_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    asc: (col: unknown) => ({ __asc: true, col }),
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

import { adminPayoutsCsvHandler } from '../payouts-csv.js';

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

const baseRow = {
  id: 'p-1',
  userId: 'u-1',
  orderId: 'o-1',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GDESTINATION',
  amountStroops: 50_000_000n,
  memoText: 'o-1',
  state: 'pending',
  txHash: null,
  lastError: null,
  attempts: 0,
  createdAt: new Date('2026-04-21T12:00:00Z'),
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
};

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  state.limitArg = 0;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminPayoutsCsvHandler', () => {
  it('returns just the header row when the window is empty', async () => {
    const res = await adminPayoutsCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="payouts-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('id,user_id,order_id')).toBe(true);
    // Header + trailing CRLF only.
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per payout with bigint + ISO coercion', async () => {
    state.rows = [
      {
        ...baseRow,
        state: 'confirmed',
        submittedAt: new Date('2026-04-21T13:00:00Z'),
        confirmedAt: new Date('2026-04-21T13:05:00Z'),
        txHash: 'abc',
      },
    ];
    const res = await adminPayoutsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const dataRow = lines[1]!;
    expect(dataRow).toContain('50000000');
    expect(dataRow).toContain('2026-04-21T12:00:00.000Z');
    expect(dataRow).toContain('2026-04-21T13:00:00.000Z');
    expect(dataRow).toContain('2026-04-21T13:05:00.000Z');
    expect(dataRow).toContain('confirmed');
    expect(dataRow).toContain('abc');
  });

  it('RFC 4180 — escapes commas and quotes in lastError', async () => {
    state.rows = [
      {
        ...baseRow,
        state: 'failed',
        failedAt: new Date('2026-04-21T14:00:00Z'),
        lastError: 'boom: "quoted", comma, and CRLF\r\nhere',
      },
    ];
    const res = await adminPayoutsCsvHandler(makeCtx());
    const body = await res.text();
    // The escaped field should appear as a single quoted token —
    // doubled quotes, CRLF preserved inside the quoted field.
    expect(body).toContain('"boom: ""quoted"", comma, and CRLF\r\nhere"');
  });

  it('truncates with __TRUNCATED__ sentinel past 10 000 rows', async () => {
    // 10 001 rows — over the cap.
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      ...baseRow,
      id: `p-${i}`,
    }));
    const res = await adminPayoutsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // Header + 10 000 rows + 1 sentinel = 10 002 lines.
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('accepts ?since and echoes the date in the filename', async () => {
    const res = await adminPayoutsCsvHandler(makeCtx({ since: '2026-04-01T00:00:00Z' }));
    expect(res.headers.get('content-disposition')).toContain('payouts-2026-04-01.csv');
  });

  it('400 on malformed ?since', async () => {
    const res = await adminPayoutsCsvHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminPayoutsCsvHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPayoutsCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('asks the repo for ROW_CAP+1 rows so truncation is detectable', async () => {
    await adminPayoutsCsvHandler(makeCtx());
    expect(state.limitArg).toBe(10_001);
  });
});
