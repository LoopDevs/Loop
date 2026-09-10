// OTP repository — ADR 013, A2-560, CF2 AUTH-01, CF-26, X-PRIV-07
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { db } from '../db/client.js';

export const OTP_LENGTH = 6;

export const OTP_TTL_MS = 10 * 60 * 1000;

export const OTP_MAX_ATTEMPTS = 5;

export const OTP_REQUESTS_PER_EMAIL_PER_MINUTE = 3;

export function generateOtpCode(): string {
  // randomInt is uniform in [0, 10**OTP_LENGTH). Avoids the modulo
  // bias a naive Math.random-then-truncate would have.
  const n = randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

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

export async function countRecentOtpsForEmail(args: {
  email: string;
  windowMs: number;
  now?: Date;
}): Promise<number> {
  const windowStart = new Date((args.now ?? new Date()).getTime() - args.windowMs);
  return db.collection('otps').count({ email: args.email, createdAt: { $gt: windowStart } });
}

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

export async function tryConsumeOtp(id: string, now?: Date): Promise<boolean> {
  const updated = await db
    .collection('otps')
    .updateOne({ id, consumedAt: null }, { $set: { consumedAt: now ?? new Date() } });
  return updated !== null;
}

export async function incrementOtpAttempts(args: { email: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .collection('otps')
    .updateMany(
      { email: args.email, consumedAt: null, expiresAt: { $gt: now } },
      { $inc: { attempts: 1 } },
    );
}

export async function purgeExpiredOtps(args: { retentionMs: number; now?: Date }): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  return db.collection('otps').deleteMany({ expiresAt: { $lt: cutoff } });
}
