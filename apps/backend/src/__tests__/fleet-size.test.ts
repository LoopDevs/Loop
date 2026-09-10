import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';

// S4-4: unit coverage for the dynamic fleet-size estimator

// `FLY_APP_NAME` is deliberately NOT part of the config file — Fly
// injects it into the machine, so `fleet-size.ts` reads it straight
// from `process.env` and these tests set it there.
const { configState } = vi.hoisted(() => ({
  configState: {
    env: 'test' as 'development' | 'production' | 'test',
    // `number | undefined` so the defensiveness test below can simulate
    // the value going missing at runtime; the schema itself defaults it.
    machineCountEstimate: 2 as number | undefined,
  },
}));

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        env: configState.env,
        rateLimit: {
          ...actual.config.rateLimit,
          machineCountEstimate: configState.machineCountEstimate as number,
        },
      };
    },
  };
});

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
  FLEET_SIZE_SCALEUP_BIAS_MS,
} from '../middleware/fleet-size.js';

beforeEach(() => {
  configState.env = 'test';
  delete process.env['FLY_APP_NAME'];
  configState.machineCountEstimate = 2;
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
    delete process.env['FLY_APP_NAME'];
    await refreshFleetSize();
    expect(resolve6Mock).not.toHaveBeenCalled();
    expect(currentFleetSizeEstimate()).toBe(2);
    expect(currentFleetSizeSource()).toBe('static');
  });

  it('uses the AAAA record count as the dynamic estimate on success', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['fdaa:1::1', 'fdaa:1::2', 'fdaa:1::3']);
    await refreshFleetSize();
    expect(resolve6Mock).toHaveBeenCalledWith('loopfinance-api.internal');
    expect(currentFleetSizeEstimate()).toBe(3);
    expect(currentFleetSizeSource()).toBe('dynamic');
  });

  it('clamps a record count above FLEET_SIZE_MAX', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(Array.from({ length: 200 }, (_, i) => `fdaa:1::${i}`));
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(FLEET_SIZE_MAX);
  });

  it('a single machine resolves to exactly FLEET_SIZE_MIN', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['fdaa:1::1']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(FLEET_SIZE_MIN);
  });

  it('treats an empty AAAA response as a failure, not a valid 0 estimate (0 would violate the min-1 floor)', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue([]);
    await refreshFleetSize();
    expect(currentFleetSizeSource()).toBe('static');
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('never throws out of refreshFleetSize when DNS rejects', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
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
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b', 'c', 'd']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(4);

    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS - 30_000));
    resolve6Mock.mockRejectedValue(new Error('timeout'));
    await refreshFleetSize();

    expect(currentFleetSizeSource()).toBe('dynamic');
    expect(currentFleetSizeEstimate()).toBe(4);
  });

  it('reverts to the static fallback once the grace period elapses without a successful refresh', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b', 'c', 'd']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(4);

    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS + 1));

    expect(currentFleetSizeSource()).toBe('static');
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('never serves a value looser than the static estimate once stale — reverts down, not up', async () => {
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a']);
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_STALE_GRACE_MS + 1));
    expect(currentFleetSizeEstimate()).toBe(2);
  });
});

describe('rapid scale-up bias (CF2-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00.000Z'));
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
  });

  it('holds the recent high-water fleet size through a transient trough so the divisor never briefly undercounts a scaling fleet', async () => {
    resolve6Mock.mockResolvedValue(Array.from({ length: 10 }, (_, i) => `fdaa:1::${i}`));
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(10);

    vi.setSystemTime(new Date(Date.now() + FLEET_SIZE_REFRESH_MS));
    resolve6Mock.mockResolvedValue(['fdaa:1::0']);
    await refreshFleetSize();

    expect(currentFleetSizeSource()).toBe('dynamic');
    expect(currentFleetSizeEstimate()).toBe(10);
  });

  it('lets a GENUINE sustained downscale take effect once the high sample ages out of the scale-up window (a bounded tightening, not a permanent max)', async () => {
    resolve6Mock.mockResolvedValue(Array.from({ length: 10 }, (_, i) => `fdaa:1::${i}`));
    await refreshFleetSize();
    expect(currentFleetSizeEstimate()).toBe(10);

    resolve6Mock.mockResolvedValue(['fdaa:1::0']);
    const start = Date.now();
    for (
      let elapsed = FLEET_SIZE_REFRESH_MS;
      elapsed <= FLEET_SIZE_SCALEUP_BIAS_MS + FLEET_SIZE_REFRESH_MS;
      elapsed += FLEET_SIZE_REFRESH_MS
    ) {
      vi.setSystemTime(new Date(start + elapsed));
      await refreshFleetSize();
    }

    expect(currentFleetSizeSource()).toBe('dynamic');
    expect(currentFleetSizeEstimate()).toBe(1);
  });
});

describe('static fallback defensiveness', () => {
  it('falls back to 1 when RATE_LIMIT_MACHINE_COUNT_ESTIMATE is undefined/non-numeric at runtime', () => {
    configState.machineCountEstimate = undefined;
    expect(currentFleetSizeEstimate()).toBe(1);
    expect(currentFleetSizeSource()).toBe('static');
  });
});

describe('startFleetSizeEstimator / stopFleetSizeEstimator lifecycle', () => {
  it('is a no-op under NODE_ENV=test (mirrors startCleanupInterval)', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    configState.env = 'test';
    startFleetSizeEstimator();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('runs an immediate refresh on start rather than waiting a full interval', async () => {
    configState.env = 'production';
    process.env['FLY_APP_NAME'] = 'loopfinance-api';
    resolve6Mock.mockResolvedValue(['a', 'b']);
    startFleetSizeEstimator();
    await Promise.resolve();
    await Promise.resolve();
    expect(currentFleetSizeEstimate()).toBe(2);
  });

  it('does not start a second interval on a repeated call', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue({
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout);
    configState.env = 'production';
    startFleetSizeEstimator();
    startFleetSizeEstimator();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('registers the interval at FLEET_SIZE_REFRESH_MS and unrefs it so it cannot pin the event loop open', () => {
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    configState.env = 'production';
    startFleetSizeEstimator();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), FLEET_SIZE_REFRESH_MS);
    expect(fakeTimer.unref).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
  });

  it('stop clears the interval and a repeated stop is a harmless no-op', () => {
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    configState.env = 'production';
    startFleetSizeEstimator();
    stopFleetSizeEstimator();
    stopFleetSizeEstimator();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
