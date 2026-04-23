import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Reconciliation handler shape:
 *   1. db.execute(sql`...drift query...`) → returns a row array
 *   2. db.select({count}).from(userCredits) → returns [{ count }]
 *
 * The mock keys each path by call order — execute first, then select.
 */
const { executeQueue, selectRows } = vi.hoisted(() => ({
  executeQueue: [] as unknown[][],
  selectRows: [] as unknown[],
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => executeQueue.shift() ?? []),
    select: vi.fn(() => ({
      from: vi.fn(async () => selectRows),
    })),
  },
}));

vi.mock('../../db/schema.js', () => ({
  userCredits: {},
}));

import { adminReconciliationHandler } from '../reconciliation.js';

function makeCtx(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  executeQueue.length = 0;
  selectRows.length = 0;
});

describe('adminReconciliationHandler', () => {
  it('returns empty drift + zero counts when the ledger has no rows', async () => {
    executeQueue.push([]);
    selectRows.push({ count: '0' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      userCount: string;
      driftedCount: string;
      drift: unknown[];
    };
    expect(body).toEqual({ userCount: '0', driftedCount: '0', drift: [] });
  });

  it('returns empty drift + non-zero userCount when every row is consistent', async () => {
    // Drift query returns nothing (no HAVING matches); count query
    // reports the total user_credits population.
    executeQueue.push([]);
    selectRows.push({ count: '42' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      userCount: string;
      driftedCount: string;
      drift: unknown[];
    };
    expect(body.userCount).toBe('42');
    expect(body.driftedCount).toBe('0');
    expect(body.drift).toEqual([]);
  });

  it('surfaces each drifted row as-is, preserving bigint-string precision', async () => {
    executeQueue.push([
      {
        userId: 'user-a',
        currency: 'GBP',
        balanceMinor: '1000',
        ledgerSumMinor: '900',
        deltaMinor: '100',
      },
      {
        userId: 'user-b',
        currency: 'USD',
        balanceMinor: '5000000000000000',
        ledgerSumMinor: '5000000000000500',
        deltaMinor: '-500',
      },
    ]);
    selectRows.push({ count: '120' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      userCount: string;
      driftedCount: string;
      drift: Array<{
        userId: string;
        currency: string;
        balanceMinor: string;
        deltaMinor: string;
      }>;
    };
    expect(body.userCount).toBe('120');
    expect(body.driftedCount).toBe('2');
    expect(body.drift).toHaveLength(2);
    expect(body.drift[0]).toMatchObject({
      userId: 'user-a',
      currency: 'GBP',
      balanceMinor: '1000',
      deltaMinor: '100',
    });
    expect(body.drift[1]?.balanceMinor).toBe('5000000000000000');
    expect(body.drift[1]?.deltaMinor).toBe('-500');
  });

  it('A2-900: surfaces orphan credit_transactions (no matching user_credits row) as drift', async () => {
    // The expanded SQL now UNIONs a second branch that finds
    // credit_transactions rows whose (user_id, currency) has no
    // user_credits counterpart. Those rows appear with balance=0,
    // ledgerSum = net sum of the orphan transactions, and a negative
    // delta (balance - ledgerSum). Prior LEFT-JOIN-anchored query
    // missed them entirely.
    executeQueue.push([
      {
        userId: 'orphan-user',
        currency: 'USD',
        balanceMinor: '0',
        ledgerSumMinor: '250',
        deltaMinor: '-250',
      },
    ]);
    selectRows.push({ count: '0' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      driftedCount: string;
      drift: Array<{
        userId: string;
        balanceMinor: string;
        ledgerSumMinor: string;
        deltaMinor: string;
      }>;
    };
    expect(body.driftedCount).toBe('1');
    expect(body.drift[0]).toMatchObject({
      userId: 'orphan-user',
      balanceMinor: '0',
      ledgerSumMinor: '250',
      deltaMinor: '-250',
    });
  });

  it('handles the { rows: [...] } wrapper shape from a future drizzle driver', async () => {
    executeQueue.push(
      // Simulate an execute result that carries rows inside a wrapper
      // instead of being the array itself. The handler normalises both.
      Object.assign(Object.create(null), {
        rows: [
          {
            userId: 'user-c',
            currency: 'EUR',
            balanceMinor: '1',
            ledgerSumMinor: '0',
            deltaMinor: '1',
          },
        ],
      }) as unknown as unknown[],
    );
    selectRows.push({ count: '1' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      driftedCount: string;
      drift: Array<{ userId: string }>;
    };
    expect(body.driftedCount).toBe('1');
    expect(body.drift[0]?.userId).toBe('user-c');
  });
});
