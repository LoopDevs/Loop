import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Chain shape: `db.select().from(orders).where?.orderBy().limit(N)`.
 * Tests push rows into `dbState.rows`; terminal `.limit()` dequeues
 * them. `.where()` captures the condition so one test can verify the
 * state filter got applied.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    whereCalls: [] as unknown[],
  },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn((cond: unknown) => {
      dbState.whereCalls.push(cond);
      return leaf;
    }),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async () => dbState.rows),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => leaf),
      })),
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  orders: {
    state: 'state',
    createdAt: 'createdAt',
  },
}));

import { adminOrdersCsvHandler } from '../orders-csv.js';

function makeCtx(
  query: Record<string, string> = {},
): Context & { __headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    req: {
      query: (k: string) => query[k],
    },
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    body: (textBody: string) =>
      new Response(textBody, {
        status: 200,
        headers: { ...headers },
      }),
    __headers: headers,
  } as unknown as Context & { __headers: Record<string, string> };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    userId: 'user-uuid',
    merchantId: 'tesco',
    state: 'fulfilled',
    currency: 'GBP',
    faceValueMinor: 5000n,
    chargeCurrency: 'GBP',
    chargeMinor: 5000n,
    paymentMethod: 'xlm',
    wholesaleMinor: 4000n,
    userCashbackMinor: 250n,
    loopMarginMinor: 750n,
    ctxOrderId: 'ctx-123',
    ctxOperatorId: 'primary',
    failureReason: null,
    createdAt: new Date('2026-04-22T10:00:00.000Z'),
    paidAt: new Date('2026-04-22T10:05:00.000Z'),
    procuredAt: new Date('2026-04-22T10:06:00.000Z'),
    fulfilledAt: new Date('2026-04-22T10:07:00.000Z'),
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.rows = [];
  dbState.whereCalls.length = 0;
});

describe('adminOrdersCsvHandler', () => {
  it('400s on an unknown state filter', async () => {
    const res = await adminOrdersCsvHandler(makeCtx({ state: 'exploded' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns just the header row on an empty table', async () => {
    const ctx = makeCtx();
    const res = await adminOrdersCsvHandler(ctx);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith('Created (UTC),State,User ID,Merchant ID,Currency,')).toBe(true);
    // No data row → body ends with the header + CRLF + empty body portion.
    expect(body.split('\r\n').length).toBe(2);
    expect(ctx.__headers['Content-Type']).toMatch(/text\/csv/);
    expect(ctx.__headers['Content-Disposition']).toContain('loop-admin-orders.csv');
    expect(ctx.__headers['Cache-Control']).toBe('private, no-store');
    expect(ctx.__headers['X-Result-Count']).toBe('0');
  });

  it('emits one row per order with bigint-string amounts + iso timestamps', async () => {
    dbState.rows = [
      makeRow(),
      makeRow({
        id: 'order-2',
        state: 'failed',
        failureReason: 'CTX wholesale out of stock',
        fulfilledAt: null,
        failedAt: new Date('2026-04-22T11:00:00.000Z'),
      }),
    ];
    const ctx = makeCtx();
    const res = await adminOrdersCsvHandler(ctx);
    const body = await res.text();
    const lines = body.split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain('fulfilled');
    expect(lines[1]).toContain('5000');
    expect(lines[1]).toContain('tesco');
    expect(lines[2]).toContain('failed');
    // failure reason contains spaces; shouldn't be quoted since no comma/quote/newline.
    expect(lines[2]).toContain('CTX wholesale out of stock');
    expect(ctx.__headers['X-Result-Count']).toBe('2');
  });

  it('names the file after the state filter when one is present', async () => {
    const ctx = makeCtx({ state: 'failed' });
    await adminOrdersCsvHandler(ctx);
    expect(ctx.__headers['Content-Disposition']).toContain('loop-admin-orders-failed.csv');
    // where() should have been called with the state filter condition
    expect(dbState.whereCalls.length).toBe(1);
  });

  it('leaves null columns (ctxOrderId, failureReason, timestamps) as empty fields', async () => {
    dbState.rows = [
      makeRow({
        state: 'pending_payment',
        ctxOrderId: null,
        ctxOperatorId: null,
        failureReason: null,
        paidAt: null,
        procuredAt: null,
        fulfilledAt: null,
        failedAt: null,
      }),
    ];
    const res = await adminOrdersCsvHandler(makeCtx());
    const body = await res.text();
    const rowLine = body.split('\r\n')[1]!;
    const cols = rowLine.split(',');
    // Exactly 19 columns, matching the CSV_HEADER order.
    expect(cols).toHaveLength(19);
    // Seven trailing columns should all be empty: ctxOrderId,
    // ctxOperator, failureReason, paidAt, procuredAt, fulfilledAt,
    // failedAt.
    expect(cols.slice(-7)).toEqual(['', '', '', '', '', '', '']);
    expect(cols[1]).toBe('pending_payment');
  });

  it('RFC 4180-quotes fields containing commas / quotes / newlines', async () => {
    dbState.rows = [
      makeRow({
        failureReason: 'rejected: "merchant closed, retry tomorrow"',
      }),
    ];
    const res = await adminOrdersCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"rejected: ""merchant closed, retry tomorrow"""');
  });
});
