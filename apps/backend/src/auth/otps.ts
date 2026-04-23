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
import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
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
        lte(otps.attempts, OTP_MAX_ATTEMPTS),
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
 * Bumps the per-row `attempts` counter. Called on a bad code guess so
 * the row locks itself out after `OTP_MAX_ATTEMPTS`.
 *
 * A2-561: target the SINGLE newest live row, not every live row for
 * the email. The prior UPDATE bumped `attempts` across the whole
 * window — if a user requested two codes back-to-back and typed a
 * wrong guess, BOTH rows got burned. A separate code (like the
 * second one they actually want to use) can't be the target of an
 * `attempts`-range check if the row is already at MAX.
 *
 * We scope the UPDATE to the single newest live row via a subselect
 * so the attempts counter is per-row again.
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
    .where(
      sql`${otps.id} = (
        SELECT ${otps.id}
        FROM ${otps}
        WHERE ${otps.email} = ${args.email}
          AND ${otps.consumedAt} IS NULL
          AND ${otps.expiresAt} > ${nowExpr}
        ORDER BY ${otps.createdAt} DESC
        LIMIT 1
      )`,
    );
}
