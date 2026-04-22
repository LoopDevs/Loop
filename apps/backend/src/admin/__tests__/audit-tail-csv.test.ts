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
const innerJoinMock = vi.fn(() => ({ where: whereMock }));
const fromMock = vi.fn(() => ({ innerJoin: innerJoinMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: {
    adminUserId: 'admin_idempotency_keys.admin_user_id',
    method: 'admin_idempotency_keys.method',
    path: 'admin_idempotency_keys.path',
    status: 'admin_idempotency_keys.status',
    key: 'admin_idempotency_keys.key',
    createdAt: 'admin_idempotency_keys.created_at',
  },
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    asc: (col: unknown) => ({ __asc: true, col }),
    eq: (_a: unknown, _b: unknown) => true,
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

import { adminAuditTailCsvHandler } from '../audit-tail-csv.js';

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
  adminUserId: '11111111-1111-1111-1111-111111111111',
  actorEmail: 'admin@loop.test',
  method: 'POST',
  path: '/api/admin/payouts/abcd/retry',
  status: 200,
  key: 'abcdefabcdef1234abcdef12',
  createdAt: new Date('2026-04-22T09:00:00Z'),
};

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  state.limitArg = 0;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  innerJoinMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminAuditTailCsvHandler', () => {
  it('returns just the header row when the window is empty', async () => {
    const res = await adminAuditTailCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="admin-audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('actor_user_id,actor_email,method')).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per audit entry with ISO timestamps', async () => {
    state.rows = [baseRow];
    const res = await adminAuditTailCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const dataRow = lines[1]!;
    expect(dataRow).toContain('admin@loop.test');
    expect(dataRow).toContain('/api/admin/payouts/abcd/retry');
    expect(dataRow).toContain('2026-04-22T09:00:00.000Z');
    expect(dataRow).toContain('200');
  });

  it('RFC 4180 — escapes quotes + commas in the path (long openapi-style paths)', async () => {
    state.rows = [
      {
        ...baseRow,
        path: '/api/admin/weird,"quoted",path',
      },
    ];
    const res = await adminAuditTailCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"/api/admin/weird,""quoted"",path"');
  });

  it('truncates with __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      ...baseRow,
      key: `k-${i.toString().padStart(24, '0')}`,
    }));
    const res = await adminAuditTailCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('accepts ?since and echoes the date in the filename', async () => {
    const res = await adminAuditTailCsvHandler(makeCtx({ since: '2026-04-01T00:00:00Z' }));
    expect(res.headers.get('content-disposition')).toContain('admin-audit-2026-04-01.csv');
  });

  it('400 on malformed ?since', async () => {
    const res = await adminAuditTailCsvHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminAuditTailCsvHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminAuditTailCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('asks the repo for ROW_CAP+1 rows so truncation is detectable', async () => {
    await adminAuditTailCsvHandler(makeCtx());
    expect(state.limitArg).toBe(10_001);
  });
});
