import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, returned } = vi.hoisted(() => {
  const state: {
    selectRows: unknown[];
    insertRows: unknown[];
    deletedRows: unknown[];
    lastOp: 'insert' | 'delete' | 'select' | null;
  } = { selectRows: [], insertRows: [], deletedRows: [], lastOp: null };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => {
    state.lastOp = 'select';
    return m;
  });
  m['from'] = vi.fn(() => m);
  m['insert'] = vi.fn(() => {
    state.lastOp = 'insert';
    return m;
  });
  m['values'] = vi.fn(() => m);
  m['onConflictDoUpdate'] = vi.fn(() => m);
  m['delete'] = vi.fn(() => {
    state.lastOp = 'delete';
    return m;
  });
  m['where'] = vi.fn(() => {
    const chainable = {
      ...m,
      then: (resolve: (rows: unknown[]) => unknown) => resolve(state.selectRows),
    };
    return chainable;
  });
  m['returning'] = vi.fn(async () => {
    if (state.lastOp === 'delete') return state.deletedRows;
    return state.insertRows;
  });
  return { dbMock: m, returned: state };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  otpAttemptCounters: {
    email: 'email',
    failedAttempts: 'failedAttempts',
    windowStartedAt: 'windowStartedAt',
    lockedUntil: 'lockedUntil',
    updatedAt: 'updatedAt',
  },
}));

import {
  isEmailOtpLocked,
  registerFailedOtpAttempt,
  clearOtpAttempts,
  purgeStaleOtpAttemptCounters,
  OTP_EMAIL_MAX_FAILED_ATTEMPTS,
  OTP_EMAIL_ATTEMPT_WINDOW_MS,
  OTP_EMAIL_LOCKOUT_MS,
} from '../otp-attempt-counter.js';

beforeEach(() => {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  returned.selectRows = [];
  returned.insertRows = [];
  returned.deletedRows = [];
  returned.lastOp = null;
});

describe('otp-attempt-counter constants', () => {
  it('keeps lockout at least as long as the counting window', () => {
    expect(OTP_EMAIL_LOCKOUT_MS).toBeGreaterThanOrEqual(OTP_EMAIL_ATTEMPT_WINDOW_MS);
    expect(OTP_EMAIL_MAX_FAILED_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe('isEmailOtpLocked', () => {
  it('returns true only when the counter row reports an active lock', async () => {
    returned.selectRows = [{ locked: true }];
    await expect(
      isEmailOtpLocked({ email: 'brute@example.com', now: new Date('2026-07-07T00:00:00Z') }),
    ).resolves.toBe(true);
    expect(dbMock['select']!).toHaveBeenCalledWith({ locked: expect.anything() });
    expect(dbMock['where']!).toHaveBeenCalled();
  });

  it('treats a missing counter row as unlocked', async () => {
    returned.selectRows = [];
    await expect(isEmailOtpLocked({ email: 'new@example.com' })).resolves.toBe(false);
  });
});

describe('registerFailedOtpAttempt', () => {
  it('inserts or atomically updates the fixed-window counter and returns the row state', async () => {
    returned.insertRows = [{ failedAttempts: 7, locked: false }];
    const now = new Date('2026-07-07T01:02:03Z');

    const out = await registerFailedOtpAttempt({ email: 'brute@example.com', now });

    expect(out).toEqual({ failedAttempts: 7, locked: false });
    expect(dbMock['values']!).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'brute@example.com',
        failedAttempts: 1,
        lockedUntil: null,
      }),
    );
    expect(dbMock['onConflictDoUpdate']!).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'email',
        set: expect.objectContaining({
          failedAttempts: expect.anything(),
          windowStartedAt: expect.anything(),
          lockedUntil: expect.anything(),
          updatedAt: expect.anything(),
        }),
      }),
    );
    expect(dbMock['returning']!).toHaveBeenCalledWith({
      failedAttempts: 'failedAttempts',
      locked: expect.anything(),
    });
  });

  it('falls back to first-attempt/unlocked if the insert returning row is absent', async () => {
    returned.insertRows = [];

    await expect(registerFailedOtpAttempt({ email: 'brute@example.com' })).resolves.toEqual({
      failedAttempts: 1,
      locked: false,
    });
  });

  it('normalizes a non-true locked value to false', async () => {
    returned.insertRows = [{ failedAttempts: OTP_EMAIL_MAX_FAILED_ATTEMPTS, locked: null }];

    await expect(registerFailedOtpAttempt({ email: 'brute@example.com' })).resolves.toEqual({
      failedAttempts: OTP_EMAIL_MAX_FAILED_ATTEMPTS,
      locked: false,
    });
  });
});

describe('clearOtpAttempts', () => {
  it('deletes the per-email counter after successful OTP verification', async () => {
    await clearOtpAttempts('legit@example.com');

    expect(dbMock['delete']!).toHaveBeenCalled();
    expect(dbMock['where']!).toHaveBeenCalled();
  });
});

describe('purgeStaleOtpAttemptCounters', () => {
  it('returns the number of stale counters deleted', async () => {
    returned.deletedRows = [{ email: 'a@example.com' }, { email: 'b@example.com' }];

    const n = await purgeStaleOtpAttemptCounters({
      retentionMs: 30 * 60 * 1000,
      now: new Date('2026-07-07T02:00:00Z'),
    });

    expect(dbMock['delete']!).toHaveBeenCalled();
    expect(dbMock['where']!).toHaveBeenCalled();
    expect(dbMock['returning']!).toHaveBeenCalledWith({ email: 'email' });
    expect(n).toBe(2);
  });

  it('returns 0 when no stale counters match', async () => {
    returned.deletedRows = [];

    await expect(purgeStaleOtpAttemptCounters({ retentionMs: 1000 })).resolves.toBe(0);
  });
});
