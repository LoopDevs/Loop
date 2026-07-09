import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S4-4 (docs/readiness-backlog-2026-07-03.md): unit coverage for the
 * dynamic fleet-size estimator that feeds the rate limiter's
 * machine-count divisor. Companion to `rate-limit.test.ts`, which
 * covers the divisor being *applied*; this file covers the divisor
 * being *computed* — fresh DNS reads, failure/grace-period handling,
 * clamping, the FLY_APP_NAME-unset fallback, and the background
 * interval's lifecycle (including that it's `.unref()`'d).
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    NODE_ENV: 'test' as string,
    FLY_APP_NAME: undefined as string | undefined,
    RATE_LIMIT_MACHINE_COUNT_ESTIMATE: 2 as number | undefined,
  },
}));

vi.mock('../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

const { resolve6Mock } = vi.hoisted(() => ({
  resolve6Mock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  resolve6: resolve6Mock,
}));

import {
  currentFleetSizeEstimate,
  currentFleetSizeSource,
  refreshFleetSize,
  startFleetSizeEstimator,
  stopFleetSizeEstimator,
  __resetFleetSizeForTests,
  FLEET_SIZE_MIN,
  FLEET_SIZE_MAX,
  FLEET_SIZE_STALE_GRACE_MS,
  FLEET_SIZE_REFRESH_MS,
} from '../middleware/fleet-size.js';

beforeEach(() => {
  envState.NODE_ENV = 'test';
  envState.FLY_APP_NAME = undefined;
  envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 2;
  resolve6Mock.mockReset();
  __resetFleetSizeForTests();
  stopFleetSizeEstimator();
});

afterEach(() => {
  stopFleetSizeEstimator();
  vi.useRealTimers();
});

describe('refreshFleetSize', () => {
  it('is a no-op (and never calls DNS) when FLY_APP_NAME is unset', async () => {
    envState.FLY_APP_NAME = undefined;
    await refreshFleetSize();
    expect(resolve6Mock).not.toHaveBeenCalled();
    expect(currentFleetSizeEstimate()).toBe(2); // static fallback
    expect(currentFleetSizeSource()).toBe('static');
  });

  it('uses the AAAA record count as the dynamic estimate on success', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['fdaa:1::1', 'fdaa:1::2', 'fdaa:1::3']);
    await refreshFleetSize();
    expect(resolve6Mock).toHaveBeenCalledWith('loopfinance-api.internal');
    expect(currentFleetSizeEstimate()).toBe(3);
    expect(currentFleetSizeSource()).toBe('dynamic');
  });

  it('clamps a record count above FLEET_SIZE_MAX', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(Array.from({ length: 200 }, (_, i) => `fdaa:1::${i}`));
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(FLEET_SIZE_MAX);
  });

  it('a single machine resolves to exactly FLEET_SIZE_MIN', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['fdaa:1::1']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(FLEET_SIZE_MIN);
  });

  it('treats an empty AAAA response as a failure, not a valid 0 estimate (0 would violate the min-1 floor)', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue([]);
    await refreshFleetSize();
    // No prior dynamic value, so this must fall back to static rather
    // than caching a bogus 0/clamped-to-1 "success".
    expect(currentFleetSizeSource()).toBe('static');
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('never throws out of refreshFleetSize when DNS rejects', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(refreshFleetSize()).resolves.toBeUndefined();
  });
});

describe('grace-period fallback behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00.000Z'));
  });

  it('keeps the last-good dynamic estimate on a subsequent DNS failure within the grace period', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b', 'c', 'd']); // 4 machines
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(4);

    // Advance well within the grace period and fail the next refresh.
    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS - 30_000));
    resolve6Mock.mockRejectedValue(new Error('timeout'));
    await refreshFleetSize();

    expect(currentFleetSizeSource()).toBe('dynamic');
    expect(currentFleetSizeEstimate()).toBe(4);
  });

  it('reverts to the static fallback once the grace period elapses without a successful refresh', async () => {
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b', 'c', 'd']); // 4 machines
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(4);

    // Advance PAST the grace period without ever succeeding again.
    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS + 1));

    expect(currentFleetSizeSource()).toBe('static');
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('never serves a value looser than the static estimate once stale — reverts down, not up', async () => {
    // Dynamic estimate is lower than static (fleet shrank to 1,
    // static configured for 2). After it goes stale, we must NOT
    // keep serving the smaller (tighter) dynamic value forever nor
    // jump to something looser — the fallback is exactly the
    // documented static estimate.
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS + 1));
    expect(currentFleetSizeEstimate()).toBe(2);
  });
});

describe('static fallback defensiveness', () => {
  it('falls back to 1 when RATE_LIMIT_MACHINE_COUNT_ESTIMATE is undefined/non-numeric at runtime', () => {
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = undefined;
    expect(currentFleetSizeEstimate()).toBe(1);
    expect(currentFleetSizeSource()).toBe('static');
  });
});

describe('startFleetSizeEstimator / stopFleetSizeEstimator lifecycle', () => {
  it('is a no-op under NODE_ENV=test (mirrors startCleanupInterval)', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    envState.NODE_ENV = 'test';
    startFleetSizeEstimator();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('runs an immediate refresh on start rather than waiting a full interval', async () => {
    envState.NODE_ENV = 'production';
    envState.FLY_APP_NAME = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b']);
    startFleetSizeEstimator();
    // Flush the fire-and-forget refresh microtask queued synchronously
    // by startFleetSizeEstimator.
    await Promise.resolve();
    await Promise.resolve();
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('does not start a second interval on a repeated call', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue({
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout);
    envState.NODE_ENV = 'production';
    startFleetSizeEstimator();
    startFleetSizeEstimator();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('registers the interval at FLEET_SIZE_REFRESH_MS and unrefs it so it cannot pin the event loop open', () => {
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    envState.NODE_ENV = 'production';
    startFleetSizeEstimator();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), FLEET_SIZE_REFRESH_MS);
    expect(fakeTimer.unref).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
  });

  it('stop clears the interval and a repeated stop is a harmless no-op', () => {
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    envState.NODE_ENV = 'production';
    startFleetSizeEstimator();
    stopFleetSizeEstimator();
    stopFleetSizeEstimator();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
