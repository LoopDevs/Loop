import { describe, it, expect, beforeEach } from 'vitest';
import { db, __resetDbForTests } from '../../db/client.js';
import {
  generateOtpCode,
  hashOtpCode,
  createOtp,
  findLiveOtp,
  tryConsumeOtp,
  countRecentOtpsForEmail,
  incrementOtpAttempts,
  purgeExpiredOtps,
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
} from '../otps.js';

/**
 * OTP repository (ADR 013), exercised against the real in-memory
 * document store so the CAS consume, the live-row predicate, and the
 * retention sweep all run for real.
 */
beforeEach(() => {
  __resetDbForTests();
});

describe('generateOtpCode', () => {
  it('returns a zero-padded decimal of the configured length', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d+$/);
      expect(code.length).toBe(OTP_LENGTH);
    }
  });
});

describe('hashOtpCode', () => {
  it('is deterministic for the same input', () => {
    expect(hashOtpCode('123456')).toBe(hashOtpCode('123456'));
  });
  it('differs across inputs', () => {
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('654321'));
  });
  it('produces a 64-char hex digest (sha256)', () => {
    expect(hashOtpCode('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createOtp', () => {
  it('stores the hash (never the plaintext) and returns id + expiry', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const out = await createOtp({ email: 'a@b.com', code: '123456', now });
    expect(out.expiresAt).toEqual(new Date(now.getTime() + OTP_TTL_MS));
    const row = await db.collection('otps').findOne({ id: out.id });
    expect(row).not.toBeNull();
    expect(row?.email).toBe('a@b.com');
    expect(row?.codeHash).toBe(hashOtpCode('123456'));
    expect(row?.codeHash).not.toBe('123456');
    expect(row?.consumedAt).toBeNull();
    expect(row?.attempts).toBe(0);
  });
});

describe('findLiveOtp', () => {
  const now = new Date('2030-01-01T00:10:00Z');

  it('returns the row when an unconsumed, unexpired match exists', async () => {
    const { id } = await createOtp({ email: 'a@b.com', code: '123456', now });
    const r = await findLiveOtp({ email: 'a@b.com', code: '123456', now });
    expect(r).toEqual({ id, attempts: 0 });
  });

  it('returns null on a wrong code', async () => {
    await createOtp({ email: 'a@b.com', code: '123456', now });
    expect(await findLiveOtp({ email: 'a@b.com', code: '000000', now })).toBeNull();
  });

  it('returns null once the row is expired', async () => {
    await createOtp({ email: 'a@b.com', code: '123456', now });
    const afterExpiry = new Date(now.getTime() + OTP_TTL_MS + 1);
    expect(await findLiveOtp({ email: 'a@b.com', code: '123456', now: afterExpiry })).toBeNull();
  });

  it('returns null once the row is consumed', async () => {
    const { id } = await createOtp({ email: 'a@b.com', code: '123456', now });
    expect(await tryConsumeOtp(id, now)).toBe(true);
    expect(await findLiveOtp({ email: 'a@b.com', code: '123456', now })).toBeNull();
  });

  it('A2-560: a row at the attempts ceiling fails the live lookup (strict less-than)', async () => {
    const { id } = await createOtp({ email: 'a@b.com', code: '123456', now });
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await incrementOtpAttempts({ email: 'a@b.com', now });
    }
    const row = await db.collection('otps').findOne({ id });
    expect(row?.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(await findLiveOtp({ email: 'a@b.com', code: '123456', now })).toBeNull();
  });

  it('prefers the most recent matching row when the same code was issued twice', async () => {
    const earlier = new Date(now.getTime() - 60_000);
    await createOtp({ email: 'a@b.com', code: '123456', now: earlier });
    const { id: newest } = await createOtp({ email: 'a@b.com', code: '123456', now });
    const r = await findLiveOtp({ email: 'a@b.com', code: '123456', now });
    expect(r?.id).toBe(newest);
  });
});

describe('tryConsumeOtp (BK-otpatomic)', () => {
  it('of two consume attempts on the same row, exactly one wins', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const { id } = await createOtp({ email: 'a@b.com', code: '123456', now });
    // The single-use CAS: first flip null → now succeeds, the replay
    // matches nothing and loses.
    expect(await tryConsumeOtp(id, now)).toBe(true);
    expect(await tryConsumeOtp(id, now)).toBe(false);
    const row = await db.collection('otps').findOne({ id });
    expect(row?.consumedAt).toEqual(now);
  });

  it('returns false for a missing row', async () => {
    expect(await tryConsumeOtp('no-such-row')).toBe(false);
  });
});

describe('countRecentOtpsForEmail', () => {
  it('counts only rows for the email inside the trailing window', async () => {
    const now = new Date('2030-01-01T01:00:00Z');
    await createOtp({ email: 'a@b.com', code: '111111', now: new Date(now.getTime() - 30_000) });
    await createOtp({ email: 'a@b.com', code: '222222', now: new Date(now.getTime() - 45_000) });
    // Outside the window — must not count.
    await createOtp({ email: 'a@b.com', code: '333333', now: new Date(now.getTime() - 120_000) });
    // Different email — must not count.
    await createOtp({ email: 'other@b.com', code: '444444', now });
    const n = await countRecentOtpsForEmail({ email: 'a@b.com', windowMs: 60_000, now });
    expect(n).toBe(2);
  });

  it('returns 0 when no rows exist', async () => {
    const n = await countRecentOtpsForEmail({ email: 'a@b.com', windowMs: 60_000 });
    expect(n).toBe(0);
  });
});

describe('incrementOtpAttempts', () => {
  // CF2 AUTH-01 regression guard: a bad guess must bump EVERY live row
  // for the email, not just the newest — the single-row shape is
  // exactly what let an attacker dodge the ceiling on an older code by
  // requesting fresh OTPs.
  it('bumps every live row for the email, not just the newest', async () => {
    const now = new Date('2030-01-01T00:05:00Z');
    const a = await createOtp({
      email: 'a@b.com',
      code: '111111',
      now: new Date(now.getTime() - 1000),
    });
    const b = await createOtp({ email: 'a@b.com', code: '222222', now });
    await incrementOtpAttempts({ email: 'a@b.com', now });
    const rowA = await db.collection('otps').findOne({ id: a.id });
    const rowB = await db.collection('otps').findOne({ id: b.id });
    expect(rowA?.attempts).toBe(1);
    expect(rowB?.attempts).toBe(1);
  });

  it('leaves consumed, expired, and other-email rows untouched', async () => {
    const now = new Date('2030-01-01T00:05:00Z');
    const consumed = await createOtp({ email: 'a@b.com', code: '111111', now });
    await tryConsumeOtp(consumed.id, now);
    const expired = await createOtp({
      email: 'a@b.com',
      code: '222222',
      now: new Date(now.getTime() - OTP_TTL_MS - 1000),
    });
    const otherEmail = await createOtp({ email: 'other@b.com', code: '333333', now });
    await incrementOtpAttempts({ email: 'a@b.com', now });
    expect((await db.collection('otps').findOne({ id: consumed.id }))?.attempts).toBe(0);
    expect((await db.collection('otps').findOne({ id: expired.id }))?.attempts).toBe(0);
    expect((await db.collection('otps').findOne({ id: otherEmail.id }))?.attempts).toBe(0);
  });
});

describe('purgeExpiredOtps (CF-26 / X-PRIV-07)', () => {
  it('deletes rows expired beyond the retention grace and returns the count', async () => {
    const now = new Date('2030-02-01T00:00:00Z');
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    // Two rows whose expiry is past the retention cutoff.
    await createOtp({
      email: 'old1@b.com',
      code: '111111',
      now: new Date(now.getTime() - retentionMs - OTP_TTL_MS - 60_000),
    });
    await createOtp({
      email: 'old2@b.com',
      code: '222222',
      now: new Date(now.getTime() - retentionMs - OTP_TTL_MS - 120_000),
    });
    // A recently-expired row inside the grace — must survive.
    await createOtp({
      email: 'recent@b.com',
      code: '333333',
      now: new Date(now.getTime() - OTP_TTL_MS - 1000),
    });
    // A live row — must survive.
    await createOtp({ email: 'live@b.com', code: '444444', now });
    const n = await purgeExpiredOtps({ retentionMs, now });
    expect(n).toBe(2);
    expect(await db.collection('otps').count()).toBe(2);
    expect(await db.collection('otps').findOne({ email: 'old1@b.com' })).toBeNull();
  });

  it('returns 0 when nothing matched', async () => {
    const n = await purgeExpiredOtps({ retentionMs: 1000 });
    expect(n).toBe(0);
  });
});
