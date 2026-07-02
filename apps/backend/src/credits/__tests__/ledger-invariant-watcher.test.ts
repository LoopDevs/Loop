import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    /** Result of the pg_try_advisory_xact_lock probe. */
    lockAcquired: { value: true },
    computeLedgerDriftSql: vi.fn<
      (
        db: unknown,
        limit: number,
      ) => Promise<
        Array<{
          userId: string;
          currency: string;
          balanceMinor: string;
          ledgerSumMinor: string;
          deltaMinor: string;
        }>
      >
    >(async () => []),
    notifyLedgerDrift: vi.fn<(args: unknown) => void>(() => undefined),
    txExecute: vi.fn(),
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mocks.txExecute.mockImplementation(async () => [
          { locked: mocks.lockAcquired.value },
        ]),
      };
      return fn(tx);
    },
  },
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('../ledger-invariant.js', () => ({
  computeLedgerDriftSql: (db: unknown, limit: number) => mocks.computeLedgerDriftSql(db, limit),
}));

vi.mock('../../discord.js', () => ({
  notifyLedgerDrift: (args: unknown) => mocks.notifyLedgerDrift(args),
}));

import { runLedgerInvariantTick } from '../ledger-invariant-watcher.js';

function driftRow(n: number): {
  userId: string;
  currency: string;
  balanceMinor: string;
  ledgerSumMinor: string;
  deltaMinor: string;
} {
  return {
    userId: `00000000-0000-4000-8000-00000000000${n}`,
    currency: 'GBP',
    balanceMinor: '100',
    ledgerSumMinor: '90',
    deltaMinor: '10',
  };
}

beforeEach(() => {
  mocks.lockAcquired.value = true;
  mocks.computeLedgerDriftSql.mockReset();
  mocks.computeLedgerDriftSql.mockResolvedValue([]);
  mocks.notifyLedgerDrift.mockReset();
  mocks.txExecute.mockClear();
});

describe('runLedgerInvariantTick', () => {
  it('returns clean and does not page when the ledger is consistent', async () => {
    const r = await runLedgerInvariantTick();
    expect(r.skipped).toBe(false);
    expect(r.drift).toEqual([]);
    expect(r.notified).toBe(false);
    expect(mocks.notifyLedgerDrift).not.toHaveBeenCalled();
  });

  it('pages Discord with a capped sample when drift exists', async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map(driftRow);
    mocks.computeLedgerDriftSql.mockResolvedValue(rows);

    const r = await runLedgerInvariantTick();
    expect(r.notified).toBe(true);
    expect(r.drift).toHaveLength(7);
    expect(mocks.notifyLedgerDrift).toHaveBeenCalledOnce();
    const arg = mocks.notifyLedgerDrift.mock.calls[0]![0] as {
      driftCount: number;
      limitHit: boolean;
      sample: unknown[];
    };
    expect(arg.driftCount).toBe(7);
    expect(arg.limitHit).toBe(false);
    expect(arg.sample).toHaveLength(5);
  });

  it('flags limitHit when the query cap was reached (real count may be higher)', async () => {
    mocks.computeLedgerDriftSql.mockResolvedValue([driftRow(1), driftRow(2)]);
    const r = await runLedgerInvariantTick({ limit: 2 });
    expect(r.notified).toBe(true);
    const arg = mocks.notifyLedgerDrift.mock.calls[0]![0] as { limitHit: boolean };
    expect(arg.limitHit).toBe(true);
  });

  it('re-pages on every tick while the drift persists (no transition dedup by design)', async () => {
    mocks.computeLedgerDriftSql.mockResolvedValue([driftRow(1)]);
    await runLedgerInvariantTick();
    await runLedgerInvariantTick();
    expect(mocks.notifyLedgerDrift).toHaveBeenCalledTimes(2);
  });

  it('skips the check (and never queries) when another machine holds the single-flight lock', async () => {
    mocks.lockAcquired.value = false;
    const r = await runLedgerInvariantTick();
    expect(r.skipped).toBe(true);
    expect(r.notified).toBe(false);
    expect(mocks.computeLedgerDriftSql).not.toHaveBeenCalled();
    expect(mocks.notifyLedgerDrift).not.toHaveBeenCalled();
  });

  it('propagates a DB error to the caller (the interval loop swallows it for the next tick)', async () => {
    mocks.computeLedgerDriftSql.mockRejectedValue(new Error('db down'));
    await expect(runLedgerInvariantTick()).rejects.toThrow('db down');
    expect(mocks.notifyLedgerDrift).not.toHaveBeenCalled();
  });
});
