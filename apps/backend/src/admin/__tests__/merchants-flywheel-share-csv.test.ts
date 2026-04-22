import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

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
  orders: {
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
    fulfilledAt: 'orders.fulfilled_at',
  },
}));

import { adminMerchantsFlywheelShareCsvHandler } from '../merchants-flywheel-share-csv.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: { query: (k: string) => query[k] },
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

describe('adminMerchantsFlywheelShareCsvHandler', () => {
  it('empty fleet — returns CSV with header only + attachment disposition', async () => {
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="merchants-flywheel-share-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'merchant_id,total_fulfilled_count,recycled_order_count,recycled_charge_minor,total_charge_minor',
    );
  });

  it('happy path — one row per merchant, bigint-as-string minor values', async () => {
    state.result = [
      {
        merchant_id: 'amazon_us',
        total_fulfilled_count: 50,
        recycled_order_count: 20,
        recycled_charge_minor: '80000',
        total_charge_minor: '200000',
      },
      {
        merchant_id: 'starbucks_uk',
        total_fulfilled_count: 30,
        recycled_order_count: 12,
        recycled_charge_minor: '36000',
        total_charge_minor: '90000',
      },
    ];
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('amazon_us,50,20,80000,200000');
    expect(lines[2]).toBe('starbucks_uk,30,12,36000,90000');
  });

  it('coerces bigint values to string (precision past 2^53)', async () => {
    state.result = [
      {
        merchant_id: 'm-1',
        total_fulfilled_count: 1n,
        recycled_order_count: 1n,
        recycled_charge_minor: 9007199254740992n + 7n,
        total_charge_minor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('m-1,1,1,9007199254740999,9007199254740999');
  });

  it('CSV-escapes merchant_ids containing commas / quotes / newlines', async () => {
    state.result = [
      {
        merchant_id: 'weird,merchant',
        total_fulfilled_count: 1,
        recycled_order_count: 1,
        recycled_charge_minor: '100',
        total_charge_minor: '100',
      },
      {
        merchant_id: 'quoted"one',
        total_fulfilled_count: 1,
        recycled_order_count: 1,
        recycled_charge_minor: '100',
        total_charge_minor: '100',
      },
    ];
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"weird,merchant"');
    expect(body).toContain('"quoted""one"');
  });

  it('400 on malformed ?since', async () => {
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when ?since exceeds the 366-day cap', async () => {
    const tooOld = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('appends __TRUNCATED__ sentinel when the query yields ROW_CAP + 1 rows', async () => {
    // Fabricate 10 001 rows to trip the truncation branch.
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10_001; i++) {
      rows.push({
        merchant_id: `m-${i}`,
        total_fulfilled_count: 1,
        recycled_order_count: 1,
        recycled_charge_minor: '100',
        total_charge_minor: '100',
      });
    }
    state.result = rows;
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // header + 10 000 data rows + __TRUNCATED__ sentinel
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminMerchantsFlywheelShareCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
