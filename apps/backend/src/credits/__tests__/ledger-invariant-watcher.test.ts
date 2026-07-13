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
    markWorkerStarted: vi.fn(),
    markWorkerStopped: vi.fn(),
    markWorkerTickFailure: vi.fn(),
    markWorkerTickSuccess: vi.fn(),
    setMoneyIntegrityBreach: vi.fn<(signal: string, active: boolean) => void>(() => undefined),
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

vi.mock('../../metrics.js', () => ({
  setMoneyIntegrityBreach: (signal: string, active: boolean) =>
    mocks.setMoneyIntegrityBreach(signal, active),
}));

vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: (...args: unknown[]) => mocks.markWorkerStarted(...args),
  markWorkerStopped: (...args: unknown[]) => mocks.markWorkerStopped(...args),
  markWorkerTickFailure: (...args: unknown[]) => mocks.markWorkerTickFailure(...args),
  markWorkerTickSuccess: (...args: unknown[]) => mocks.markWorkerTickSuccess(...args),
}));

import {
  runLedgerInvariantTick,
  startLedgerInvariantWatcher,
  stopLedgerInvariantWatcher,
} from '../ledger-invariant-watcher.js';

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
  stopLedgerInvariantWatcher();
  mocks.lockAcquired.value = true;
  mocks.computeLedgerDriftSql.mockReset();
  mocks.computeLedgerDriftSql.mockResolvedValue([]);
  mocks.notifyLedgerDrift.mockReset();
  mocks.txExecute.mockClear();
  mocks.markWorkerStarted.mockReset();
  mocks.markWorkerStopped.mockReset();
  mocks.markWorkerTickFailure.mockReset();
  mocks.markWorkerTickSuccess.mockReset();
  mocks.setMoneyIntegrityBreach.mockReset();
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

describe('ledger-invariant watcher lifecycle', () => {
  async function flushTick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('starts once, runs an immediate tick, records health, and stops', async () => {
    startLedgerInvariantWatcher({ intervalMs: 60_000 });
    startLedgerInvariantWatcher({ intervalMs: 60_000 });

    await flushTick();

    expect(mocks.markWorkerStarted).toHaveBeenCalledOnce();
    expect(mocks.computeLedgerDriftSql).toHaveBeenCalledOnce();
    expect(mocks.markWorkerTickSuccess).toHaveBeenCalledOnce();

    stopLedgerInvariantWatcher();
    stopLedgerInvariantWatcher();

    expect(mocks.markWorkerStopped).toHaveBeenCalledOnce();
  });

  it('NS-02: a tick that finds drift marks the money-integrity signal BREACHED while still reporting worker liveness', async () => {
    mocks.computeLedgerDriftSql.mockResolvedValue([driftRow(1), driftRow(2)]);

    startLedgerInvariantWatcher({ intervalMs: 60_000 });
    await flushTick();

    // The invariant is violated, so the money-integrity gauge must read
    // BREACHED — this is the signal that makes a standing ledger drift
    // visible on /metrics independent of Discord (FT-07). Before the
    // fix the watcher set nothing here and only called
    // markWorkerTickSuccess, so a live drift was a green dashboard.
    expect(mocks.setMoneyIntegrityBreach).toHaveBeenCalledWith('ledger_invariant', true);
    // Liveness is NOT sacrificed: the tick still ran, so the worker
    // must ALSO report success — "worker ran" and "worker found a
    // breach" are two distinct facts (NS-02).
    expect(mocks.markWorkerTickSuccess).toHaveBeenCalledOnce();

    stopLedgerInvariantWatcher();
  });

  it('NS-02: a clean tick marks the money-integrity signal HEALTHY (drift cleared)', async () => {
    mocks.computeLedgerDriftSql.mockResolvedValue([]);

    startLedgerInvariantWatcher({ intervalMs: 60_000 });
    await flushTick();

    expect(mocks.setMoneyIntegrityBreach).toHaveBeenCalledWith('ledger_invariant', false);
    expect(mocks.markWorkerTickSuccess).toHaveBeenCalledOnce();

    stopLedgerInvariantWatcher();
  });

  it('NS-02: a lock-skipped tick leaves the money-integrity signal untouched (no fresh reading)', async () => {
    mocks.lockAcquired.value = false;

    startLedgerInvariantWatcher({ intervalMs: 60_000 });
    await flushTick();

    // This machine never computed the invariant this tick, so it must
    // NOT overwrite a possibly-breached last-known value with a
    // stale-clean 0 — leave the gauge to the machine that held the lock.
    expect(mocks.setMoneyIntegrityBreach).not.toHaveBeenCalled();
    // Liveness still recorded (the loop is alive, reached the lock probe).
    expect(mocks.markWorkerTickSuccess).toHaveBeenCalledOnce();

    stopLedgerInvariantWatcher();
  });

  it('marks tick failures without throwing out of the interval loop', async () => {
    const err = new Error('db unavailable');
    mocks.computeLedgerDriftSql.mockRejectedValue(err);

    startLedgerInvariantWatcher({ intervalMs: 60_000 });
    await flushTick();

    expect(mocks.markWorkerTickFailure).toHaveBeenCalledWith('ledger_invariant_watcher', err);
    expect(mocks.markWorkerTickSuccess).not.toHaveBeenCalled();

    stopLedgerInvariantWatcher();
  });
});
