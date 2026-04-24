import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

interface SnapshotLike {
  outstanding: Record<string, string>;
  totals: Record<string, Record<string, string>>;
  liabilities: Record<string, { outstandingMinor: string; issuer: string | null }>;
  assets: Record<string, { stroops: string | null }>;
  payouts: Record<string, string>;
  operatorPool: { size: number; operators: Array<{ id: string; state: string }> };
}

const state = vi.hoisted(() => ({
  jsonBody: null as SnapshotLike | null,
  jsonStatus: 200,
  throwErr: null as Error | null,
}));

vi.mock('../treasury.js', () => ({
  treasuryHandler: vi.fn(async () => {
    if (state.throwErr !== null) throw state.throwErr;
    return new Response(JSON.stringify(state.jsonBody), {
      status: state.jsonStatus,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminTreasurySnapshotCsvHandler } from '../treasury-snapshot-csv.js';

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

const emptySnapshot: SnapshotLike = {
  outstanding: {},
  totals: {},
  liabilities: {},
  assets: {},
  payouts: {},
  operatorPool: { size: 0, operators: [] },
};

beforeEach(() => {
  state.jsonBody = emptySnapshot;
  state.jsonStatus = 200;
  state.throwErr = null;
});

describe('adminTreasurySnapshotCsvHandler', () => {
  it('returns header + snapshot_taken_at + operator_pool_size rows on empty snapshot', async () => {
    const res = await adminTreasurySnapshotCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('metric,key,value');
    expect(lines[1]?.startsWith('snapshot_taken_at,,')).toBe(true);
    expect(lines.some((l) => l === 'operator_pool_size,,0')).toBe(true);
  });

  it('emits stable Content-Disposition with a treasury-snapshot filename', async () => {
    const res = await adminTreasurySnapshotCsvHandler(makeCtx());
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment; filename="treasury-snapshot-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('flattens a rich snapshot into long-form (metric,key,value) rows', async () => {
    state.jsonBody = {
      outstanding: { USD: '15000', GBP: '8000' },
      totals: { USD: { cashback: '20000', withdrawal: '-5000' } },
      liabilities: {
        USDLOOP: { outstandingMinor: '15000', issuer: 'GABC' },
        GBPLOOP: { outstandingMinor: '0', issuer: null },
      },
      assets: { USDC: { stroops: '50000000000' }, XLM: { stroops: null } },
      payouts: { pending: '12', submitted: '3', confirmed: '42', failed: '0' },
      operatorPool: {
        size: 2,
        operators: [
          { id: 'op-beta-02', state: 'half_open' },
          { id: 'op-alpha-01', state: 'closed' },
        ],
      },
    };
    const res = await adminTreasurySnapshotCsvHandler(makeCtx());
    const body = await res.text();

    // Outstanding, sorted by currency.
    expect(body).toContain('\r\noutstanding,GBP,8000\r\n');
    expect(body).toContain('\r\noutstanding,USD,15000\r\n');

    // Ledger totals combine currency + type in the key.
    expect(body).toContain('\r\nledger_total,USD:cashback,20000\r\n');
    // A2-1602: leading `-` is prefixed with `'` in the raw CSV so
    // spreadsheet apps don't evaluate it as a negative formula.
    expect(body).toContain("\r\nledger_total,USD:withdrawal,'-5000\r\n");

    // Liabilities emit both value and issuer rows.
    expect(body).toContain('\r\nliability,USDLOOP,15000\r\n');
    expect(body).toContain('\r\nliability_issuer,USDLOOP,GABC\r\n');
    expect(body).toContain('\r\nliability_issuer,GBPLOOP,\r\n'); // null issuer → empty string

    // Asset stroops; null → empty.
    expect(body).toContain('\r\nasset_stroops,USDC,50000000000\r\n');
    expect(body).toContain('\r\nasset_stroops,XLM,\r\n');

    // Payout states.
    expect(body).toContain('\r\npayout_state,failed,0\r\n');
    expect(body).toContain('\r\npayout_state,confirmed,42\r\n');

    // Operator pool size.
    expect(body).toContain('\r\noperator_pool_size,,2\r\n');

    // Operators sorted by id ascending.
    const alpha = body.indexOf('operator,op-alpha-01,closed');
    const beta = body.indexOf('operator,op-beta-02,half_open');
    expect(alpha).toBeGreaterThan(0);
    expect(beta).toBeGreaterThan(alpha);
  });

  it('passes through non-200 from the upstream snapshot handler', async () => {
    state.jsonStatus = 500;
    state.jsonBody = { code: 'INTERNAL_ERROR' } as unknown as SnapshotLike;
    const res = await adminTreasurySnapshotCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('500s when the upstream handler throws', async () => {
    state.throwErr = new Error('boom');
    const res = await adminTreasurySnapshotCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
