/**
 * Per-email OTP verification attempt counter (hardening B5; ADR 013).
 *
 * The authoritative brute-force ceiling for `verify-otp`, decoupled
 * from the OTP row lifecycle. A fixed-window count of failed verify
 * attempts per email: cross `OTP_EMAIL_MAX_FAILED_ATTEMPTS` inside
 * `OTP_EMAIL_ATTEMPT_WINDOW_MS` and verify is locked for the email for
 * `OTP_EMAIL_LOCKOUT_MS`, regardless of how many fresh codes exist. So
 * an attacker cannot dodge the ceiling by rotating `request-otp` to
 * keep issuing new rows — the limit is at the identity, not the row.
 */
import { db } from '../db/client.js';
import type { OtpAttemptCounterDoc } from '../db/types.js';

/**
 * Failed verify attempts allowed per email inside the window before
 * lockout. Generous enough that a fat-fingering user is unaffected
 * (they rarely miss 10×); a brute-forcer gets ≤10 guesses per window
 * against a 10⁶ space — negligible.
 */
export const OTP_EMAIL_MAX_FAILED_ATTEMPTS = 10;

/** Fixed counting window. */
export const OTP_EMAIL_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Lockout duration once the threshold is crossed. */
export const OTP_EMAIL_LOCKOUT_MS = 15 * 60 * 1000;

// INVARIANT (load-time): lockout must be >= the counting window. It's
// what guarantees an EXPIRED lockout always meets a LAPSED window, so
// the first post-lockout guess resets the count to 1 rather than
// incrementing a stale count straight back over the threshold (which
// would make the lock near-permanent). If a future tweak sets lockout
// shorter than the window, fail fast rather than ship a silent
// re-lock loop.
if (OTP_EMAIL_LOCKOUT_MS < OTP_EMAIL_ATTEMPT_WINDOW_MS) {
  throw new Error(
    'OTP_EMAIL_LOCKOUT_MS must be >= OTP_EMAIL_ATTEMPT_WINDOW_MS (else an expired lockout can re-lock without resetting the window)',
  );
}

/**
 * Is `email` currently locked out of verify? True when a lockout was
 * set and has not yet elapsed. Read-only — call before checking the
 * code so a locked email never even reaches the hash comparison.
 */
export async function isEmailOtpLocked(args: { email: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const row = await db.collection('otp_attempt_counters').findOne({ email: args.email });
  return row !== null && row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
}

export interface RegisterFailedAttemptResult {
  /** Failed-attempt count in the (possibly just-reset) window. */
  failedAttempts: number;
  /** True when THIS attempt tipped the email into (or kept it in) lockout. */
  locked: boolean;
}

/**
 * Record one failed verify attempt for `email` and report whether the
 * email is now locked. Fixed-window semantics: if the current window
 * has lapsed (or no row exists) it resets to a fresh window with count
 * 1; otherwise it increments. Crossing the threshold stamps
 * `lockedUntil = now + lockout`.
 *
 * Node's single-threaded execution makes the read-modify-write below
 * atomic against concurrent guesses in the memory driver; under the
 * mongo driver a lost increment across two exactly-simultaneous bad
 * guesses costs one count — acceptable for a rate ceiling.
 */
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

/**
 * Clear an email's counter on a SUCCESSFUL verify — a legitimate user
 * who fat-fingered a few times then got it right starts fresh.
 */
export async function clearOtpAttempts(email: string): Promise<void> {
  await db.collection('otp_attempt_counters').deleteMany({ email });
}

/**
 * Retention sweep — delete counters whose window AND any lockout are
 * both well in the past. Called by the auth-row purge worker alongside
 * `purgeExpiredOtps` / `purgeDeadRefreshTokens`. Keyed on `updatedAt`
 * so an actively-counting or actively-locked email is never reaped.
 */
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
