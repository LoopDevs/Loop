// Integration tests for per-email OTP attempt counter (hardening B5) — pins fixed-window / lockout / reset store semantics the unit mock can't exercise
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetDbForTests } from '../../db/client.js';
import {
  isEmailOtpLocked,
  registerFailedOtpAttempt,
  clearOtpAttempts,
  purgeStaleOtpAttemptCounters,
  OTP_EMAIL_MAX_FAILED_ATTEMPTS,
  OTP_EMAIL_ATTEMPT_WINDOW_MS,
  OTP_EMAIL_LOCKOUT_MS,
} from '../../auth/otp-attempt-counter.js';

const EMAIL = 'brute@example.com';
const T0 = new Date('2026-07-03T00:00:00Z');

beforeEach(() => {
  __resetDbForTests();
});

describe('registerFailedOtpAttempt / isEmailOtpLocked', () => {
  it('increments within the window and locks exactly at the threshold', async () => {
    let last = { failedAttempts: 0, locked: false };
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      const at = new Date(T0.getTime() + i * 1000);
      last = await registerFailedOtpAttempt({ email: EMAIL, now: at });
      expect(last.failedAttempts).toBe(i);
      expect(last.locked).toBe(i >= OTP_EMAIL_MAX_FAILED_ATTEMPTS);
    }
    const lockedAt = new Date(T0.getTime() + 60_000);
    expect(await isEmailOtpLocked({ email: EMAIL, now: lockedAt })).toBe(true);
  });

  it('does not lock below the threshold', async () => {
    for (let i = 1; i < OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({ email: EMAIL, now: new Date(T0.getTime() + i * 1000) });
    }
    expect(await isEmailOtpLocked({ email: EMAIL, now: new Date(T0.getTime() + 60_000) })).toBe(
      false,
    );
  });

  it('resets the count when a fresh attempt lands after the window lapses', async () => {
    await registerFailedOtpAttempt({ email: EMAIL, now: T0 });
    await registerFailedOtpAttempt({ email: EMAIL, now: new Date(T0.getTime() + 1000) });
    const afterWindow = new Date(T0.getTime() + OTP_EMAIL_ATTEMPT_WINDOW_MS + 1000);
    const reset = await registerFailedOtpAttempt({ email: EMAIL, now: afterWindow });
    expect(reset.failedAttempts).toBe(1);
    expect(reset.locked).toBe(false);
  });

  it('after a lockout EXPIRES, the next guess resets to 1 — never re-locks at count+1', async () => {
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({ email: EMAIL, now: new Date(T0.getTime() + i * 1000) });
    }
    const afterLockout = new Date(
      T0.getTime() + OTP_EMAIL_MAX_FAILED_ATTEMPTS * 1000 + OTP_EMAIL_LOCKOUT_MS + 1000,
    );
    const first = await registerFailedOtpAttempt({ email: EMAIL, now: afterLockout });
    expect(first.failedAttempts).toBe(1);
    expect(first.locked).toBe(false);
    expect(await isEmailOtpLocked({ email: EMAIL, now: afterLockout })).toBe(false);
  });

  it('clearOtpAttempts wipes the counter (successful verify)', async () => {
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({ email: EMAIL, now: new Date(T0.getTime() + i * 1000) });
    }
    expect(await isEmailOtpLocked({ email: EMAIL, now: new Date(T0.getTime() + 60_000) })).toBe(
      true,
    );
    await clearOtpAttempts(EMAIL);
    expect(await isEmailOtpLocked({ email: EMAIL, now: new Date(T0.getTime() + 60_000) })).toBe(
      false,
    );
  });

  it('lockout is per-email — one locked email does not lock another', async () => {
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({ email: EMAIL, now: new Date(T0.getTime() + i * 1000) });
    }
    expect(await isEmailOtpLocked({ email: EMAIL, now: new Date(T0.getTime() + 60_000) })).toBe(
      true,
    );
    expect(
      await isEmailOtpLocked({ email: 'other@example.com', now: new Date(T0.getTime() + 60_000) }),
    ).toBe(false);
  });

  it('purge reaps a stale counter but spares an actively-locked one', async () => {
    await registerFailedOtpAttempt({ email: 'stale@example.com', now: T0 });
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({
        email: EMAIL,
        now: new Date(T0.getTime() + 100 * 60 * 1000 + i * 1000),
      });
    }
    const sweepNow = new Date(T0.getTime() + 100 * 60 * 1000 + 60_000);
    const deleted = await purgeStaleOtpAttemptCounters({
      retentionMs: 30 * 60 * 1000,
      now: sweepNow,
    });
    expect(deleted).toBe(1);
    expect(await isEmailOtpLocked({ email: EMAIL, now: sweepNow })).toBe(true);
  });
});
