import { describe, it, expect, vi, beforeEach } from 'vitest';

const { purgeExpiredOtps, purgeDeadRefreshTokens, purgeStaleOtpAttemptCounters } = vi.hoisted(
  () => ({
    purgeExpiredOtps: vi.fn(async () => 0),
    purgeDeadRefreshTokens: vi.fn(async () => 0),
    purgeStaleOtpAttemptCounters: vi.fn(async () => 0),
  }),
);

vi.mock('../otps.js', () => ({ purgeExpiredOtps }));
vi.mock('../refresh-tokens.js', () => ({ purgeDeadRefreshTokens }));
vi.mock('../otp-attempt-counter.js', () => ({ purgeStaleOtpAttemptCounters }));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
// Pin env so the default-retention math is deterministic.
vi.mock('../../env.js', () => ({
  env: {
    LOOP_AUTH_ROW_RETENTION_DAYS: 30,
    LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS: 1,
  },
}));
// runtime-health markers are fire-and-forget; stub them so the tick
// doesn't touch the real registry.
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickFailure: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
}));

import { runAuthRowPurgeTick } from '../auth-row-purge.js';

beforeEach(() => {
  purgeExpiredOtps.mockClear();
  purgeDeadRefreshTokens.mockClear();
  purgeStaleOtpAttemptCounters.mockClear();
  purgeExpiredOtps.mockResolvedValue(0);
  purgeDeadRefreshTokens.mockResolvedValue(0);
  purgeStaleOtpAttemptCounters.mockResolvedValue(0);
});

describe('runAuthRowPurgeTick', () => {
  it('sweeps both tables and returns each delete count', async () => {
    purgeExpiredOtps.mockResolvedValue(5);
    purgeDeadRefreshTokens.mockResolvedValue(3);
    purgeStaleOtpAttemptCounters.mockResolvedValue(2);
    const r = await runAuthRowPurgeTick();
    expect(r).toEqual({ otpsDeleted: 5, refreshTokensDeleted: 3, otpAttemptCountersDeleted: 2 });
    expect(purgeExpiredOtps).toHaveBeenCalledTimes(1);
    expect(purgeDeadRefreshTokens).toHaveBeenCalledTimes(1);
    expect(purgeStaleOtpAttemptCounters).toHaveBeenCalledTimes(1);
  });

  it('defaults retentionMs to LOOP_AUTH_ROW_RETENTION_DAYS', async () => {
    await runAuthRowPurgeTick();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(purgeExpiredOtps).toHaveBeenCalledWith(
      expect.objectContaining({ retentionMs: thirtyDaysMs }),
    );
    expect(purgeDeadRefreshTokens).toHaveBeenCalledWith(
      expect.objectContaining({ retentionMs: thirtyDaysMs }),
    );
  });

  it('honours an explicit retentionMs + now override', async () => {
    const now = new Date('2026-06-15T00:00:00Z');
    await runAuthRowPurgeTick({ retentionMs: 1000, now });
    expect(purgeExpiredOtps).toHaveBeenCalledWith({ retentionMs: 1000, now });
    expect(purgeDeadRefreshTokens).toHaveBeenCalledWith({ retentionMs: 1000, now });
    expect(purgeStaleOtpAttemptCounters).toHaveBeenCalledWith({ retentionMs: 1000, now });
  });

  it('propagates a sweep failure to the caller (the interval loop swallows it)', async () => {
    purgeExpiredOtps.mockRejectedValue(new Error('db down'));
    await expect(runAuthRowPurgeTick()).rejects.toThrow('db down');
  });
});
