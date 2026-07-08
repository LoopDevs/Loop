import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Reconciliation handler shape:
 *   1. db.transaction(...) scopes the request-local statement timeout.
 *   2. tx.execute(sql`set_config(...)`) → returns an ignored row array.
 *   3. tx.execute(sql`...drift query...`) → returns a row array.
 *   4. tx.select({count}).from(userCredits) → returns [{ count }]
 *
 * The mock keys each execute path by call order.
 */
const { executeQueue, selectRows } = vi.hoisted(() => ({
  executeQueue: [] as unknown[][],
  selectRows: [] as unknown[],
}));

vi.mock('../../db/client.js', () => ({
  db: (() => {
    const mockedDb = {
      execute: vi.fn(async () => executeQueue.shift() ?? []),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockedDb)),
      select: vi.fn(() => ({
        from: vi.fn(async () => selectRows),
      })),
    };
    return mockedDb;
  })(),
}));

vi.mock('../../db/schema.js', () => ({
  userCredits: {},
}));

import { db } from '../../db/client.js';
import {
  __resetReconciliationCacheForTests,
  adminReconciliationHandler,
} from '../reconciliation.js';

const dbMock = db as unknown as {
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

function queueReconciliation(driftRows: unknown[]): void {
  executeQueue.push([], driftRows);
}

function resetDbMocks(): void {
  dbMock.execute.mockClear();
  dbMock.transaction.mockClear();
  dbMock.select.mockClear();
}

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
  __resetReconciliationCacheForTests();
  resetDbMocks();
});

describe('adminReconciliationHandler', () => {
  it('returns empty drift + zero counts when the ledger has no rows', async () => {
    queueReconciliation([]);
    selectRows.push({ count: '0' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      rowCount: string;
      driftedCount: string;
      drift: unknown[];
    };
    expect(body).toEqual({ rowCount: '0', driftedCount: '0', drift: [] });
  });

  it('returns empty drift + non-zero rowCount when every row is consistent', async () => {
    // Drift query returns nothing (no HAVING matches); count query
    // reports the total user_credits population.
    queueReconciliation([]);
    selectRows.push({ count: '42' });
    const res = await adminReconciliationHandler(makeCtx());
    const body = (await res.json()) as {
      rowCount: string;
      driftedCount: string;
      drift: unknown[];
    };
    expect(body.rowCount).toBe('42');
    expect(body.driftedCount).toBe('0');
    expect(body.drift).toEqual([]);
  });

  it('surfaces each drifted row as-is, preserving bigint-string precision', async () => {
    queueReconciliation([
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
      rowCount: string;
      driftedCount: string;
      drift: Array<{
        userId: string;
        currency: string;
        balanceMinor: string;
        deltaMinor: string;
      }>;
    };
    expect(body.rowCount).toBe('120');
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
    queueReconciliation([
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
      [],
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

  it('S4-6: sets a transaction-local statement timeout before the full drift scan', async () => {
    queueReconciliation([]);
    selectRows.push({ count: '0' });
    await adminReconciliationHandler(makeCtx());
    expect(dbMock.transaction).toHaveBeenCalledOnce();
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it('S4-6: serves the response from a short cache on immediate repeat requests', async () => {
    queueReconciliation([]);
    selectRows.push({ count: '7' });
    const first = await adminReconciliationHandler(makeCtx());
    const second = await adminReconciliationHandler(makeCtx());
    await first.json();
    const body = (await second.json()) as { rowCount: string };
    expect(body.rowCount).toBe('7');
    expect(dbMock.transaction).toHaveBeenCalledOnce();
  });
});
