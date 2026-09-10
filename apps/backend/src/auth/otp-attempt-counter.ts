// Per-email OTP verification attempt counter — B5, ADR 013
import { db } from '../db/client.js';
import type { OtpAttemptCounterDoc } from '../db/types.js';

// Identity-level ceiling: prevents brute-force evasion via rotating `request-otp` to issue fresh rows.
export const OTP_EMAIL_MAX_FAILED_ATTEMPTS = 10;

export const OTP_EMAIL_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export const OTP_EMAIL_LOCKOUT_MS = 15 * 60 * 1000;

// INVARIANT: lockout >= window ensures an expired lockout meets a lapsed window, resetting count to 1.
// Prevents silent re-lock loops if lockout is shorter than window.
if (OTP_EMAIL_LOCKOUT_MS < OTP_EMAIL_ATTEMPT_WINDOW_MS) {
  throw new Error(
    'OTP_EMAIL_LOCKOUT_MS must be >= OTP_EMAIL_ATTEMPT_WINDOW_MS (else an expired lockout can re-lock without resetting the window)',
  );
}

export async function isEmailOtpLocked(args: { email: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const row = await db.collection('otp_attempt_counters').findOne({ email: args.email });
  return row !== null && row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
}

export interface RegisterFailedAttemptResult {
  failedAttempts: number;
  locked: boolean;
}

// Node single-threaded execution makes read-modify-write atomic in memory driver; mongo driver may lose one increment on simultaneous guesses.
export async function registerFailedOtpAttempt(args: {
  email: string;
  now?: Date;
}): Promise<RegisterFailedAttemptResult> {
  const now = args.now ?? new Date();
  const counters = db.collection('otp_attempt_counters');
  const existing = await counters.findOne({ email: args.email });

  const windowLapsed =
    existing === null ||
    existing.windowStartedAt.getTime() < now.getTime() - OTP_EMAIL_ATTEMPT_WINDOW_MS;
  const failedAttempts = windowLapsed ? 1 : existing.failedAttempts + 1;
  const lockedUntil =
    failedAttempts >= OTP_EMAIL_MAX_FAILED_ATTEMPTS
      ? new Date(now.getTime() + OTP_EMAIL_LOCKOUT_MS)
      : (existing?.lockedUntil ?? null);

  const doc: OtpAttemptCounterDoc = {
    email: args.email,
    failedAttempts,
    windowStartedAt: existing !== null && !windowLapsed ? existing.windowStartedAt : now,
    lockedUntil,
    updatedAt: now,
  };
  await counters.replaceOne({ email: args.email }, doc, { upsert: true });

  return {
    failedAttempts,
    locked: lockedUntil !== null && lockedUntil.getTime() > now.getTime(),
  };
}

export async function clearOtpAttempts(email: string): Promise<void> {
  await db.collection('otp_attempt_counters').deleteMany({ email });
}

// Keyed on `updatedAt` so actively-counting or locked emails are never reaped.
export async function purgeStaleOtpAttemptCounters(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  const counters = db.collection('otp_attempt_counters');
  const stale = await counters.findMany({ updatedAt: { $lt: cutoff } });
  let deleted = 0;
  for (const row of stale) {
    if (row.lockedUntil === null || row.lockedUntil.getTime() < cutoff.getTime()) {
      deleted += await counters.deleteMany({ email: row.email, updatedAt: { $lt: cutoff } });
    }
  }
  return deleted;
}
