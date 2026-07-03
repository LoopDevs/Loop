/**
 * Per-email OTP verification attempt counter (hardening B5; ADR 013).
 *
 * The authoritative brute-force ceiling for `verify-otp`, decoupled
 * from the OTP row lifecycle (see the `otp_attempt_counters` schema
 * comment). A fixed-window count of failed verify attempts per email:
 * cross `OTP_EMAIL_MAX_FAILED_ATTEMPTS` inside
 * `OTP_EMAIL_ATTEMPT_WINDOW_MS` and verify is locked for the email for
 * `OTP_EMAIL_LOCKOUT_MS`, regardless of how many fresh codes exist. So
 * an attacker cannot dodge the ceiling by rotating `request-otp` to
 * keep issuing new rows — the limit is at the identity, not the row.
 *
 * All timestamp math is done in SQL (`NOW()`, interval arithmetic) so
 * we never serialise a JS `Date` across the postgres-js parameter
 * bridge; `now` overrides are ISO strings cast to timestamptz, the
 * same pattern as `otps.incrementOtpAttempts`.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { otpAttemptCounters } from '../db/schema.js';

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

function nowExpr(now?: Date): SQL {
  return now === undefined ? sql`NOW()` : sql`${now.toISOString()}::timestamptz`;
}

/**
 * Is `email` currently locked out of verify? True when a lockout was
 * set and has not yet elapsed. Read-only — call before checking the
 * code so a locked email never even reaches the hash comparison.
 */
export async function isEmailOtpLocked(args: { email: string; now?: Date }): Promise<boolean> {
  const [row] = await db
    .select({ locked: sql<boolean>`${otpAttemptCounters.lockedUntil} > ${nowExpr(args.now)}` })
    .from(otpAttemptCounters)
    .where(eq(otpAttemptCounters.email, args.email));
  return row?.locked === true;
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
 * `locked_until = now + lockout`.
 *
 * Done in a single upsert under the row's implicit lock so concurrent
 * failed guesses for the same email can't race the counter.
 */
export async function registerFailedOtpAttempt(args: {
  email: string;
  now?: Date;
}): Promise<RegisterFailedAttemptResult> {
  const now = nowExpr(args.now);
  const windowMs = OTP_EMAIL_ATTEMPT_WINDOW_MS;
  const lockoutMs = OTP_EMAIL_LOCKOUT_MS;
  const max = OTP_EMAIL_MAX_FAILED_ATTEMPTS;

  // `next_failed` = 1 when the stored window has lapsed, else prior+1.
  // `locked_until` set when next_failed >= max. All computed in SQL so
  // the read-modify-write is atomic under ON CONFLICT's row lock.
  const [row] = await db
    .insert(otpAttemptCounters)
    .values({
      email: args.email,
      failedAttempts: 1,
      windowStartedAt: sql`${now}`,
      lockedUntil: max <= 1 ? sql`${now} + ${`${lockoutMs} milliseconds`}::interval` : null,
      updatedAt: sql`${now}`,
    })
    .onConflictDoUpdate({
      target: otpAttemptCounters.email,
      set: {
        failedAttempts: sql`CASE
          WHEN ${otpAttemptCounters.windowStartedAt} < ${now} - ${`${windowMs} milliseconds`}::interval
          THEN 1
          ELSE ${otpAttemptCounters.failedAttempts} + 1
        END`,
        windowStartedAt: sql`CASE
          WHEN ${otpAttemptCounters.windowStartedAt} < ${now} - ${`${windowMs} milliseconds`}::interval
          THEN ${now}
          ELSE ${otpAttemptCounters.windowStartedAt}
        END`,
        lockedUntil: sql`CASE
          WHEN (CASE
            WHEN ${otpAttemptCounters.windowStartedAt} < ${now} - ${`${windowMs} milliseconds`}::interval
            THEN 1
            ELSE ${otpAttemptCounters.failedAttempts} + 1
          END) >= ${max}
          THEN ${now} + ${`${lockoutMs} milliseconds`}::interval
          ELSE ${otpAttemptCounters.lockedUntil}
        END`,
        updatedAt: sql`${now}`,
      },
    })
    .returning({
      failedAttempts: otpAttemptCounters.failedAttempts,
      locked: sql<boolean>`${otpAttemptCounters.lockedUntil} > ${now}`,
    });

  return {
    failedAttempts: row?.failedAttempts ?? 1,
    locked: row?.locked === true,
  };
}

/**
 * Clear an email's counter on a SUCCESSFUL verify — a legitimate user
 * who fat-fingered a few times then got it right starts fresh.
 */
export async function clearOtpAttempts(email: string): Promise<void> {
  await db.delete(otpAttemptCounters).where(eq(otpAttemptCounters.email, email));
}

/**
 * Retention sweep — delete counters whose window AND any lockout are
 * both well in the past. Called by the auth-row purge worker alongside
 * `purgeExpiredOtps` / `purgeDeadRefreshTokens`. Keyed on `updated_at`
 * so an actively-counting or actively-locked email is never reaped.
 */
export async function purgeStaleOtpAttemptCounters(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff =
    args.now === undefined
      ? sql`NOW() - ${`${args.retentionMs} milliseconds`}::interval`
      : sql`${args.now.toISOString()}::timestamptz - ${`${args.retentionMs} milliseconds`}::interval`;
  const deleted = await db
    .delete(otpAttemptCounters)
    .where(
      sql`${otpAttemptCounters.updatedAt} < ${cutoff}
        AND (${otpAttemptCounters.lockedUntil} IS NULL OR ${otpAttemptCounters.lockedUntil} < ${cutoff})`,
    )
    .returning({ email: otpAttemptCounters.email });
  return deleted.length;
}
