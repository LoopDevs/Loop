import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * DB mock: handler calls `db.execute(sql\`...\`)` once and expects
 * either a bare array or `{ rows }` envelope (postgres-js / node-
 * postgres parity). Tests push the desired shape into `state.result`;
 * set `state.throw` to exercise the 500 path.
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
  users: 'users',
  orders: {
    userId: 'user_id',
    state: 'state',
    paymentMethod: 'payment_method',
    chargeMinor: 'charge_minor',
    chargeCurrency: 'charge_currency',
  },
}));

import { adminUserFlywheelStatsHandler } from '../user-flywheel-stats.js';

function makeCtx(params: Record<string, string> = {}): Context {
  return {
    req: { param: (k: string) => params[k] },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const validUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  state.result = [];
  state.throw = false;
});

describe('adminUserFlywheelStatsHandler', () => {
  it('400 when userId missing', async () => {
    const res = await adminUserFlywheelStatsHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId not a uuid', async () => {
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: 'not-uuid' }));
    expect(res.status).toBe(400);
  });

  it('404 when the user does not exist (empty rows)', async () => {
    state.result = [];
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('happy path — recycled + total counts + bigint-as-string charges', async () => {
    state.result = [
      {
        currency: 'GBP',
        recycledOrderCount: 3,
        recycledChargeMinor: '12000',
        totalFulfilledCount: 10,
        totalFulfilledChargeMinor: '50000',
      },
    ];
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      userId: validUserId,
      currency: 'GBP',
      recycledOrderCount: 3,
      recycledChargeMinor: '12000',
      totalFulfilledCount: 10,
      totalFulfilledChargeMinor: '50000',
    });
  });

  it('existing user, zero fulfilled orders — zeroed response, not 404', async () => {
    state.result = [
      {
        currency: 'USD',
        recycledOrderCount: 0,
        recycledChargeMinor: '0',
        totalFulfilledCount: 0,
        totalFulfilledChargeMinor: '0',
      },
    ];
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      recycledOrderCount: 0,
      totalFulfilledCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledChargeMinor: '0',
    });
  });

  it('preserves bigint precision past 2^53 for charge totals', async () => {
    state.result = [
      {
        currency: 'GBP',
        recycledOrderCount: 1,
        recycledChargeMinor: 9007199254740992n + 7n,
        totalFulfilledCount: 1,
        totalFulfilledChargeMinor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    const body = (await res.json()) as {
      recycledChargeMinor: string;
      totalFulfilledChargeMinor: string;
    };
    expect(body.recycledChargeMinor).toBe('9007199254740999');
    expect(body.totalFulfilledChargeMinor).toBe('9007199254740999');
  });

  it('handles `{ rows }` envelope shape (driver parity)', async () => {
    state.result = {
      rows: [
        {
          currency: 'EUR',
          recycledOrderCount: 2,
          recycledChargeMinor: '800',
          totalFulfilledCount: 5,
          totalFulfilledChargeMinor: '2000',
        },
      ],
    };
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      currency: 'EUR',
      recycledOrderCount: 2,
      totalFulfilledCount: 5,
    });
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminUserFlywheelStatsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });
});
