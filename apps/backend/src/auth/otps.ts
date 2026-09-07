/**
 * OTP repository (ADR 013). Owns code generation, hashing, and the
 * document-store writes against the `otps` collection. Handlers
 * consume this; they do not touch the db directly.
 *
 * Codes are 6-digit decimal drawn from a CSPRNG. We store SHA-256 of
 * the code — the plaintext only ever lives in the email body and the
 * POST body of `verify-otp`. Attempts are capped per-row; the handler
 * bumps `attempts` on each bad code and rejects further tries once
 * the ceiling is hit.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';

/** OTP code length. Matches CTX's current UX so the overlap window is consistent. */
export const OTP_LENGTH = 6;

/** OTP lifetime — 10 min, the upper end of what users tolerate without another "send". */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Per-OTP-row bad-code ceiling. At 5 tries × 10⁶ codes, online brute force is not viable. */
export const OTP_MAX_ATTEMPTS = 5;

/** Per-email per-minute `request-otp` cap (the route rate-limit is a separate per-IP cap). */
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
  const id = randomUUID();
  await db.collection('otps').insertOne({
    id,
    email: args.email,
    codeHash: hashOtpCode(args.code),
    expiresAt,
    consumedAt: null,
    attempts: 0,
    createdAt: issuedAt,
  });
  return { id, expiresAt };
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
  return db.collection('otps').count({ email: args.email, createdAt: { $gt: windowStart } });
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
  const row = await db.collection('otps').findOne(
    {
      email: args.email,
      codeHash: hashOtpCode(args.code),
      consumedAt: null,
      expiresAt: { $gt: now },
      // A2-560: strict less-than so OTP_MAX_ATTEMPTS is the true
      // ceiling — a row at attempts=MAX fails the live lookup and the
      // verify handler returns 401 as if the code were wrong.
      attempts: { $lt: OTP_MAX_ATTEMPTS },
    },
    { sort: [['createdAt', 'desc']] },
  );
  return row === null ? null : { id: row.id, attempts: row.attempts };
}

/**
 * BK-otpatomic: atomic single-use consume — the compare-and-set half of
 * verify-otp. Flips `consumedAt` from null → now in ONE conditional
 * update and reports whether THIS call was the one that did it (`true`
 * iff exactly one row went unconsumed → consumed here). Of two
 * concurrent callers exactly one matches the live row; the other
 * matches nothing and loses — no read-then-mark window remains.
 */
export async function tryConsumeOtp(id: string, now?: Date): Promise<boolean> {
  const updated = await db
    .collection('otps')
    .updateOne({ id, consumedAt: null }, { $set: { consumedAt: now ?? new Date() } });
  return updated !== null;
}

/**
 * Bumps the `attempts` counter on every live (unconsumed, unexpired) OTP
 * row for the email. Called on a bad code guess so each outstanding row
 * locks itself out after `OTP_MAX_ATTEMPTS` — bumping every live row
 * (CF2 AUTH-01) closes the rotate-request-otp bypass; the per-email
 * counter in `otp-attempt-counter.ts` is the authoritative ceiling.
 */
export async function incrementOtpAttempts(args: { email: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .collection('otps')
    .updateMany(
      { email: args.email, consumedAt: null, expiresAt: { $gt: now } },
      { $inc: { attempts: 1 } },
    );
}

/**
 * CF-26 / X-PRIV-07: retention sweep. Deletes OTP rows whose
 * `expiresAt` is older than `now - retentionMs`. An expired OTP is
 * never re-used, and the collection holds `email` + a code hash, so an
 * unbounded `otps` collection is a slowly-growing PII store with no
 * lawful retention basis. Keyed on `expiresAt` so consumed and
 * abandoned rows are reclaimed uniformly; the `retentionMs` grace
 * keeps very recently-expired rows around briefly.
 */
export async function purgeExpiredOtps(args: { retentionMs: number; now?: Date }): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  return db.collection('otps').deleteMany({ expiresAt: { $lt: cutoff } });
}
