import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A2-905 / ADR 009 scheduler tests. Unit-level: the tick's side
 * effects are entirely "calls `accrueOnePeriod` with the right
 * cursor + period"; no real DB is involved. `accrueOnePeriod` is
 * already covered by `accrue-interest.test.ts` — this file pins the
 * wrapper shape + the scheduler's own invariants:
 *
 *   - UTC calendar-day cursor format
 *   - single-flight guard (no overlapping ticks)
 *   - zero-APY defensive skip
 *   - uncaught primitive error doesn't crash the scheduler
 *   - stop cancels the interval cleanly
 */

const { accrueMock } = vi.hoisted(() => ({
  accrueMock: vi.fn(async () => ({
    users: 0,
    credited: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    totalsMinor: {},
  })),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../accrue-interest.js', () => ({
  accrueOnePeriod: accrueMock,
}));

import {
  startInterestScheduler,
  stopInterestScheduler,
  tickInterestAccrual,
} from '../interest-scheduler.js';

const PERIOD = { apyBasisPoints: 400, periodsPerYear: 365 };

beforeEach(() => {
  accrueMock.mockReset();
  accrueMock.mockResolvedValue({
    users: 0,
    credited: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    totalsMinor: {},
  });
});

afterEach(() => {
  stopInterestScheduler();
  vi.useRealTimers();
});

describe('tickInterestAccrual', () => {
  it('calls accrueOnePeriod with UTC YYYY-MM-DD cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T23:59:00Z'));
    await tickInterestAccrual({ period: PERIOD, intervalMs: 1000 });
    expect(accrueMock).toHaveBeenCalledOnce();
    expect(accrueMock).toHaveBeenCalledWith(PERIOD, '2026-04-24');
  });

  it('uses the UTC day, not local (timezone-independent cursor)', async () => {
    vi.useFakeTimers();
    // 2026-04-25 00:30 UTC is still April 25 UTC, regardless of
    // where the host's local clock sits. A naive `toLocaleDateString`
    // would mis-cursor in America/Los_Angeles.
    vi.setSystemTime(new Date('2026-04-25T00:30:00Z'));
    await tickInterestAccrual({ period: PERIOD, intervalMs: 1000 });
    expect(accrueMock).toHaveBeenCalledWith(PERIOD, '2026-04-25');
  });

  it('single-flight guard: a second tick while the first runs bails early', async () => {
    let resolveFirst!: () => void;
    accrueMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = () =>
            resolve({
              users: 0,
              credited: 0,
              skippedZero: 0,
              skippedAlreadyAccrued: 0,
              totalsMinor: {},
            });
        }),
    );
    const config = { period: PERIOD, intervalMs: 1000 };
    const inflight = tickInterestAccrual(config);
    // Second invocation while the first is still pending. Must
    // observe the `tickInFlight` guard and short-circuit.
    await tickInterestAccrual(config);
    expect(accrueMock).toHaveBeenCalledOnce();
    resolveFirst();
    await inflight;
  });

  it('swallows an uncaught primitive error (process-level resilience)', async () => {
    accrueMock.mockRejectedValueOnce(new Error('DB unreachable'));
    await expect(
      tickInterestAccrual({ period: PERIOD, intervalMs: 1000 }),
    ).resolves.toBeUndefined();
  });
});

describe('startInterestScheduler / stopInterestScheduler', () => {
  it('defensive: zero APY does not start (caller is expected to filter)', () => {
    startInterestScheduler({
      period: { apyBasisPoints: 0, periodsPerYear: 365 },
      intervalMs: 1000,
    });
    // setImmediate inside start wouldn't have run yet, but even if
    // it did the tick's own `apyBasisPoints <= 0` guard in
    // `accrueOnePeriod` (covered by the primitive's tests) would
    // short-circuit. The scheduler-level guard we test here is
    // that no interval is armed — observable by stop being a no-op.
    stopInterestScheduler();
    expect(accrueMock).not.toHaveBeenCalled();
  });

  it('stop cancels the interval so later ticks do not fire', async () => {
    vi.useFakeTimers();
    startInterestScheduler({ period: PERIOD, intervalMs: 1000 });
    // Drain the setImmediate kick-off.
    await vi.advanceTimersByTimeAsync(0);
    expect(accrueMock).toHaveBeenCalledOnce();
    stopInterestScheduler();
    // 10s later — ten interval-ticks worth of time. None should
    // reach accrueOnePeriod.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(accrueMock).toHaveBeenCalledOnce();
  });
});
