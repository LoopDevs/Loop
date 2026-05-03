import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

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

vi.mock('../../db/schema.js', () => ({
  orders: {
    userId: 'orders.user_id',
    state: 'orders.state',
    paymentMethod: 'orders.payment_method',
    chargeMinor: 'orders.charge_minor',
    chargeCurrency: 'orders.charge_currency',
  },
}));

const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
    upsertThrow: null as Error | null,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async () => {
    if (userState.upsertThrow !== null) throw userState.upsertThrow;
    return userState.byId;
  }),
}));

const { jwtState } = vi.hoisted(() => ({
  jwtState: { claims: null as Record<string, unknown> | null },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getUserFlywheelStatsHandler } from '../flywheel-stats.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'u-1',
  email: 'u-1@example.com',
  bearerToken: 'stub-bearer',
};

function makeCtx(auth: LoopAuthContext | undefined): Context {
  return {
    req: {},
    get: (k: string) => (k === 'auth' ? auth : undefined),
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
  userState.byId = { id: 'u-1', homeCurrency: 'GBP' };
  userState.upsertThrow = null;
  jwtState.claims = null;
});

describe('getUserFlywheelStatsHandler', () => {
  it('401 when unauthenticated (no auth context)', async () => {
    const res = await getUserFlywheelStatsHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('happy path — returns recycled + total counts + charges as bigint strings', async () => {
    state.rows = [
      {
        recycledOrderCount: 3,
        recycledChargeMinor: '12000',
        totalFulfilledCount: 10,
        totalFulfilledChargeMinor: '50000',
      },
    ];
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      recycledOrderCount: 3,
      recycledChargeMinor: '12000',
      totalFulfilledCount: 10,
      totalFulfilledChargeMinor: '50000',
    });
  });

  it('zero-activity user — returns 0/0 rather than null / NaN', async () => {
    // Empty rows happens when postgres returns a row with all NULLs
    // because there's no fulfilled-order activity. COALESCE on the
    // server handles SUM; COUNT returns 0 naturally.
    state.rows = [
      {
        recycledOrderCount: 0,
        recycledChargeMinor: '0',
        totalFulfilledCount: 0,
        totalFulfilledChargeMinor: '0',
      },
    ];
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 0,
      totalFulfilledChargeMinor: '0',
    });
  });

  it('coerces bigint-valued charge totals to string (precision preserved past 2^53)', async () => {
    state.rows = [
      {
        recycledOrderCount: 1,
        recycledChargeMinor: 9007199254740992n + 7n,
        totalFulfilledCount: 1,
        totalFulfilledChargeMinor: 9007199254740992n + 7n,
      },
    ];
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as {
      recycledChargeMinor: string;
      totalFulfilledChargeMinor: string;
    };
    expect(body.recycledChargeMinor).toBe('9007199254740999');
    expect(body.totalFulfilledChargeMinor).toBe('9007199254740999');
  });

  it('empty db result — missing row — returns zeroed scalar (not 500)', async () => {
    state.rows = [];
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 0,
      totalFulfilledChargeMinor: '0',
    });
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });

  it('handles the `{ rows }` envelope shape (postgres-js / node-postgres parity)', async () => {
    // Re-mock db.execute to return the envelope shape.
    state.rows = [] as unknown as never;
    const { db } = await import('../../db/client.js');
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        {
          recycledOrderCount: 2,
          recycledChargeMinor: '800',
          totalFulfilledCount: 5,
          totalFulfilledChargeMinor: '2000',
        },
      ],
    } as never);
    const res = await getUserFlywheelStatsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      recycledOrderCount: 2,
      totalFulfilledCount: 5,
    });
  });
});
