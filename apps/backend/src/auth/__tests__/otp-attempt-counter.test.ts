import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import {
  isEmailOtpLocked,
  registerFailedOtpAttempt,
  clearOtpAttempts,
  purgeStaleOtpAttemptCounters,
  OTP_EMAIL_MAX_FAILED_ATTEMPTS,
  OTP_EMAIL_ATTEMPT_WINDOW_MS,
  OTP_EMAIL_LOCKOUT_MS,
} from '../otp-attempt-counter.js';

// Per-email OTP attempt counter (hardening B5) unit tests
beforeEach(() => {
  __resetDbForTests();
});

const T0 = new Date('2026-07-07T00:00:00Z');

describe('otp-attempt-counter constants', () => {
  it('keeps lockout at least as long as the counting window', () => {
    expect(OTP_EMAIL_LOCKOUT_MS).toBeGreaterThanOrEqual(OTP_EMAIL_ATTEMPT_WINDOW_MS);
    expect(OTP_EMAIL_MAX_FAILED_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe('isEmailOtpLocked', () => {
  it('returns true only while a lockout is active', async () => {
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({
        email: 'brute@example.com',
        now: new Date(T0.getTime() + i * 1000),
      });
    }
    const during = new Date(T0.getTime() + 60_000);
    await expect(isEmailOtpLocked({ email: 'brute@example.com', now: during })).resolves.toBe(true);
    const after = new Date(
      T0.getTime() + OTP_EMAIL_MAX_FAILED_ATTEMPTS * 1000 + OTP_EMAIL_LOCKOUT_MS + 1000,
    );
    await expect(isEmailOtpLocked({ email: 'brute@example.com', now: after })).resolves.toBe(false);
  });

  it('treats a missing counter row as unlocked', async () => {
    await expect(isEmailOtpLocked({ email: 'new@example.com' })).resolves.toBe(false);
  });
});

describe('registerFailedOtpAttempt', () => {
  it('inserts the first-attempt counter row and returns its state', async () => {
    const out = await registerFailedOtpAttempt({ email: 'brute@example.com', now: T0 });
    expect(out).toEqual({ failedAttempts: 1, locked: false });
    const row = await db.collection('otp_attempt_counters').findOne({ email: 'brute@example.com' });
    expect(row?.failedAttempts).toBe(1);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.windowStartedAt).toEqual(T0);
  });

  it('increments within the window and locks exactly at the threshold', async () => {
    let last = { failedAttempts: 0, locked: false };
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      last = await registerFailedOtpAttempt({
        email: 'brute@example.com',
        now: new Date(T0.getTime() + i * 1000),
      });
      expect(last.failedAttempts).toBe(i);
      expect(last.locked).toBe(i >= OTP_EMAIL_MAX_FAILED_ATTEMPTS);
    }
    const row = await db.collection('otp_attempt_counters').findOne({ email: 'brute@example.com' });
    expect(row?.lockedUntil).not.toBeNull();
  });

  it('counts per email — one identity never bleeds into another', async () => {
    await registerFailedOtpAttempt({ email: 'a@example.com', now: T0 });
    const out = await registerFailedOtpAttempt({ email: 'b@example.com', now: T0 });
    expect(out.failedAttempts).toBe(1);
  });
});

describe('clearOtpAttempts', () => {
  it('deletes the per-email counter after successful OTP verification', async () => {
    for (let i = 1; i <= OTP_EMAIL_MAX_FAILED_ATTEMPTS; i++) {
      await registerFailedOtpAttempt({
        email: 'legit@example.com',
        now: new Date(T0.getTime() + i * 1000),
      });
    }
    await clearOtpAttempts('legit@example.com');
    expect(
      await db.collection('otp_attempt_counters').findOne({ email: 'legit@example.com' }),
    ).toBeNull();
    await expect(
      isEmailOtpLocked({ email: 'legit@example.com', now: new Date(T0.getTime() + 60_000) }),
    ).resolves.toBe(false);
  });
});

describe('purgeStaleOtpAttemptCounters', () => {
  it('returns the number of stale counters deleted, sparing active ones', async () => {
    await registerFailedOtpAttempt({ email: 'a@example.com', now: T0 });
    await registerFailedOtpAttempt({ email: 'b@example.com', now: T0 });
    const sweepNow = new Date(T0.getTime() + 100 * 60 * 1000);
    await registerFailedOtpAttempt({ email: 'fresh@example.com', now: sweepNow });

    const n = await purgeStaleOtpAttemptCounters({
      retentionMs: 30 * 60 * 1000,
      now: sweepNow,
    });
    expect(n).toBe(2);
    expect(
      await db.collection('otp_attempt_counters').findOne({ email: 'a@example.com' }),
    ).toBeNull();
    expect(
      await db.collection('otp_attempt_counters').findOne({ email: 'fresh@example.com' }),
    ).not.toBeNull();
  });

  it('returns 0 when no stale counters match', async () => {
    await expect(purgeStaleOtpAttemptCounters({ retentionMs: 1000 })).resolves.toBe(0);
  });
});
