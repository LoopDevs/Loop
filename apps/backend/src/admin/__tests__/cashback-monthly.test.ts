import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * DB mock: the handler runs a single `db.execute(sql\`...\`)` and
 * accepts both the bare-array (postgres-js) and `{ rows }` (node-
 * postgres) shapes.
 */
const { state } = vi.hoisted(() => ({
  state: {
    result: [] as Array<Record<string, unknown>> | { rows: Array<Record<string, unknown>> },
    throw: false,
  },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throw) throw new Error('db exploded');
      return state.result;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    type: 'credit_transactions.type',
    amountMinor: 'credit_transactions.amount_minor',
    currency: 'credit_transactions.currency',
    createdAt: 'credit_transactions.created_at',
  },
}));

import { adminCashbackMonthlyHandler } from '../cashback-monthly.js';

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
  state.result = [];
  state.throw = false;
});

describe('adminCashbackMonthlyHandler', () => {
  it('happy path — multi-currency rows preserved, bigint-as-string', async () => {
    state.result = [
      { month: '2026-03-01T00:00:00.000Z', currency: 'GBP', cashback_minor: '120000' },
      { month: '2026-03-01T00:00:00.000Z', currency: 'USD', cashback_minor: '45000' },
      { month: '2026-04-01T00:00:00.000Z', currency: 'GBP', cashback_minor: '180000' },
    ];
    const res = await adminCashbackMonthlyHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toEqual([
      { month: '2026-03', currency: 'GBP', cashbackMinor: '120000' },
      { month: '2026-03', currency: 'USD', cashbackMinor: '45000' },
      { month: '2026-04', currency: 'GBP', cashbackMinor: '180000' },
    ]);
  });

  it('empty ledger — returns an empty entries array, not 500', async () => {
    state.result = [];
    const res = await adminCashbackMonthlyHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('coerces bigint `cashback_minor` values to string (precision preserved)', async () => {
    // 2^53 + 42 — would lose precision through Number coercion.
    state.result = [
      {
        month: new Date('2026-04-01T00:00:00Z'),
        currency: 'GBP',
        cashback_minor: 9007199254740992n + 42n,
      },
    ];
    const res = await adminCashbackMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ cashbackMinor: string }> };
    expect(body.entries[0]?.cashbackMinor).toBe('9007199254741034');
  });

  it('coerces number `cashback_minor` and truncates (defensive)', async () => {
    state.result = [{ month: '2026-04-01', currency: 'USD', cashback_minor: 12345.9 }];
    const res = await adminCashbackMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ cashbackMinor: string }> };
    expect(body.entries[0]?.cashbackMinor).toBe('12345');
  });

  it('handles `{ rows }` envelope shape (postgres-js / node-postgres parity)', async () => {
    state.result = {
      rows: [{ month: '2026-04-01T00:00:00.000Z', currency: 'EUR', cashback_minor: '7200' }],
    };
    const res = await adminCashbackMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toEqual([{ month: '2026-04', currency: 'EUR', cashbackMinor: '7200' }]);
  });

  it('Date-valued `month` columns also format to YYYY-MM UTC', async () => {
    state.result = [
      { month: new Date(Date.UTC(2026, 1, 1)), currency: 'GBP', cashback_minor: '100' },
    ];
    const res = await adminCashbackMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ month: string }> };
    expect(body.entries[0]?.month).toBe('2026-02');
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminCashbackMonthlyHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
