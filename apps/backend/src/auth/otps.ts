/**
 * OTP repository (ADR 013). Owns code generation, hashing, and the
 * database writes against the `otps` table. Handlers consume this;
 * they do not call the db directly.
 *
 * Codes are 6-digit decimal drawn from a CSPRNG. We store SHA-256 of
 * the code — the plaintext only ever lives in the email body and the
 * POST body of `verify-otp`. Attempts are capped per-row; the handler
 * bumps `attempts` on each bad code and rejects further tries once
 * the ceiling is hit.
 */
import { createHash, randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { otps } from '../db/schema.js';

/** OTP code length. Matches CTX's current UX so the overlap window is consistent. */
export const OTP_LENGTH = 6;

/** OTP lifetime — 10 min, the upper end of what users tolerate without another "send". */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Per-OTP-row bad-code ceiling. At 5 tries × 10⁶ codes, online brute force is not viable. */
export const OTP_MAX_ATTEMPTS = 5;

/** Per-email per-minute `request-otp` cap (app.ts rate-limit uses a separate per-IP cap). */
export const OTP_REQUESTS_PER_EMAIL_PER_MINUTE = 3;

/** Generates a zero-padded 6-digit decimal code. */
export function generateOtpCode(): string {
  // randomInt is uniform in [0, 10**OTP_LENGTH). Avoids the modulo
  // bias a naive Math.random-then-truncate would have.
  const n = randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

/** SHA-256 of the code. We never store the plaintext. */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Insert a fresh OTP for `email`. Returns the row for handler logging / response. */
export async function createOtp(args: {
  email: string;
  code: string;
  now?: Date;
}): Promise<{ id: string; expiresAt: Date }> {
  const issuedAt = args.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + OTP_TTL_MS);
  const [row] = await db
    .insert(otps)
    .values({
      email: args.email,
      codeHash: hashOtpCode(args.code),
      expiresAt,
    })
    .returning({ id: otps.id, expiresAt: otps.expiresAt });
  if (row === undefined) {
    throw new Error('createOtp: no row returned');
  }
  return { id: row.id, expiresAt: row.expiresAt };
}

/**
 * Counts OTP rows issued for `email` within the trailing `windowMs`.
 * Used by `request-otp` to apply a per-email cap on top of the per-IP
 * rate limit — stops an attacker rotating IPs to flood one email.
 */
export async function countRecentOtpsForEmail(args: {
  email: string;
  windowMs: number;
  now?: Date;
}): Promise<number> {
  const windowStart = new Date((args.now ?? new Date()).getTime() - args.windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otps)
    .where(and(eq(otps.email, args.email), gt(otps.createdAt, windowStart)));
  return row?.n ?? 0;
}

/**
 * Finds the most recent unconsumed, unexpired OTP row for an email whose
 * hash matches the provided plaintext code. Returns `null` when no such
 * row exists (wrong code, expired, or already consumed).
 */
export async function findLiveOtp(args: {
  email: string;
  code: string;
  now?: Date;
}): Promise<{ id: string; attempts: number } | null> {
  const now = args.now ?? new Date();
  const codeHash = hashOtpCode(args.code);
  const rows = await db
    .select({ id: otps.id, attempts: otps.attempts })
    .from(otps)
    .where(
      and(
        eq(otps.email, args.email),
        eq(otps.codeHash, codeHash),
        isNull(otps.consumedAt),
        gt(otps.expiresAt, now),
        // A2-560: strict less-than (`lt`) so OTP_MAX_ATTEMPTS is the
        // true ceiling. Prior `lte` let attempts reach MAX before
        // bumping to MAX+1 — effectively allowed MAX+1 bad guesses.
        // With `lt`, a row at attempts=MAX fails the live-lookup;
        // verify handler returns 401 as if the code were wrong.
        lt(otps.attempts, OTP_MAX_ATTEMPTS),
      ),
    )
    .orderBy(desc(otps.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Marks the OTP row consumed. Called inside the verify-otp txn on success. */
export async function markOtpConsumed(id: string, now?: Date): Promise<void> {
  await db
    .update(otps)
    .set({ consumedAt: now ?? new Date() })
    .where(eq(otps.id, id));
}

/**
 * BK-otpatomic: atomic single-use consume — the compare-and-set half of
 * verify-otp. Flips `consumed_at` from NULL → now() in ONE conditional
 * UPDATE and reports whether THIS call was the one that did it (`true`
 * iff exactly one row went unconsumed → consumed here).
 *
 * `markOtpConsumed` above is an UNCONDITIONAL update: paired with a prior
 * `findLiveOtp` read it forms a read-then-mark gap where two concurrent
 * verify calls both observe the row unconsumed and both mark it, so both
 * succeed — breaking single-use (an OTP replay / double-consume). This
 * closes the gap: the `consumed_at IS NULL` predicate is evaluated inside
 * the UPDATE under a row lock, so of two concurrent callers exactly one
 * matches the live row (rowCount === 1 → returns `true`, wins) while the
 * other re-reads the now-consumed row and matches nothing (0 rows →
 * `false`, loses). No read-then-mark window remains.
 *
 * Mirrors the refresh path's `tryRevokeIfLive` CAS (A4-098): an
 * `UPDATE ... WHERE <still-live> RETURNING` whose result gates the mint.
 */
export async function tryConsumeOtp(id: string, now?: Date): Promise<boolean> {
  const rows = await db
    .update(otps)
    .set({ consumedAt: now ?? new Date() })
    .where(and(eq(otps.id, id), isNull(otps.consumedAt)))
    .returning({ id: otps.id });
  return rows.length === 1;
}

/**
 * Bumps the `attempts` counter on every live (unconsumed, unexpired) OTP
 * row for the email. Called on a bad code guess so each outstanding row
 * locks itself out after `OTP_MAX_ATTEMPTS`.
 *
 * CF2 AUTH-01 (2026-06-30 cold audit) / reverts A2-561: A2-561 scoped this
 * to the SINGLE newest live row so a user holding two live codes (e.g. they
 * requested a second one before the first email arrived) wouldn't have
 * their *other* still-wanted code burned by an unrelated typo. That fix
 * introduced a real bypass: an attacker can keep calling `request-otp`
 * (issuing fresh rows) between guesses, so every wrong guess bumps only
 * the newest row while an older still-live code's `attempts` counter never
 * moves — the 5-attempt ceiling on that row is never reached, defeating
 * the "online brute force is not viable" guarantee `OTP_MAX_ATTEMPTS`
 * documents. Bumping every live row closes that hole: no matter how many
 * fresh codes exist, a wrong guess costs an attempt against ALL of them,
 * so an attacker can't dodge the ceiling by rotating which row is newest.
 *
 * Trade-off (deliberately accepted): a user who mistypes a code 5 times
 * while holding two live codes loses both and must request a new one —
 * a minor UX cost, and strictly better than an unbounded guess window.
 * Better fix (not implemented here — a small schema change, flagged as a
 * follow-up in the 2026-06-30 audit's remediation plan): track failed
 * attempts per-email in a dedicated counter decoupled from the OTP row
 * lifecycle entirely, so a sibling code's guess-budget is never touched
 * by a wrong guess against a different one.
 */
export async function incrementOtpAttempts(args: { email: string; now?: Date }): Promise<void> {
  // `args.now` is accepted for test-time overrides (the call sites
  // pass a fixed clock in a few legacy tests). Prefer NOW() in-SQL
  // so we never serialise a JS Date across postgres-js's parameter
  // bridge, which historically throws on Date values.
  const nowExpr = args.now === undefined ? sql`NOW()` : sql`${args.now.toISOString()}::timestamptz`;
  await db
    .update(otps)
    .set({ attempts: sql`${otps.attempts} + 1` })
    .where(and(eq(otps.email, args.email), isNull(otps.consumedAt), gt(otps.expiresAt, nowExpr)));
}

/**
 * CF-26 / X-PRIV-07: retention sweep. Deletes OTP rows whose
 * `expires_at` is older than `now - retentionMs`. An expired OTP is
 * never re-used (verify-otp only matches live, unconsumed rows), and
 * the table holds `email` + a code hash, so an unbounded `otps` table
 * is a slowly-growing PII store with no lawful retention basis.
 *
 * We key the sweep on `expires_at` (not `consumed_at`) so it reclaims
 * both branches uniformly: a consumed row's `expires_at` is in the
 * past once the 10-min TTL elapses, and an abandoned (never-verified)
 * row expires on the same clock. The `retentionMs` grace keeps very
 * recently-expired rows around briefly so an in-flight verify against
 * a just-expired code still returns the same 401 it would today rather
 * than a "row vanished" edge case.
 *
 * Uses the `otps_email_expires` index for the range scan. Returns the
 * number of rows deleted so the worker can log a non-zero sweep.
 */
export async function purgeExpiredOtps(args: { retentionMs: number; now?: Date }): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  const deleted = await db
    .delete(otps)
    .where(lt(otps.expiresAt, cutoff))
    .returning({ id: otps.id });
  return deleted.length;
}
