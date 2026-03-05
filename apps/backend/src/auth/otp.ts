import { randomInt } from 'crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_LENGTH = 6;

interface OtpEntry {
  otp: string;
  expiresAt: number;
  attempts: number;
}

/** In-memory OTP store keyed by lowercase email. */
const otpStore = new Map<string, OtpEntry>();

/** Generates and stores a 6-digit OTP for the given email. Returns the OTP. */
export function generateOtp(email: string): string {
  const otp = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  otpStore.set(email.toLowerCase(), {
    otp,
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });
  return otp;
}

export type OtpVerifyResult =
  | { success: true }
  | { success: false; reason: 'not_found' | 'expired' | 'invalid' | 'too_many_attempts' };

/** Verifies the OTP. On success the entry is deleted (single-use). */
export function verifyOtp(email: string, otp: string): OtpVerifyResult {
  const key = email.toLowerCase();
  const entry = otpStore.get(key);

  if (entry === undefined) return { success: false, reason: 'not_found' };

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(key);
    return { success: false, reason: 'expired' };
  }

  if (entry.attempts >= 5) {
    otpStore.delete(key);
    return { success: false, reason: 'too_many_attempts' };
  }

  if (entry.otp !== otp) {
    entry.attempts++;
    return { success: false, reason: 'invalid' };
  }

  // Valid — delete to prevent replay
  otpStore.delete(key);
  return { success: true };
}

/** Removes expired OTP entries. Call periodically. */
export function evictExpiredOtps(): void {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt) {
      otpStore.delete(key);
    }
  }
}
