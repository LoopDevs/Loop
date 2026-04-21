/**
 * Loop-native auth handlers (ADR 013). Activated by the
 * `LOOP_AUTH_NATIVE_ENABLED` env flag; the `requestOtpHandler` in
 * `handler.ts` dispatches here when the flag is on.
 *
 * Currently ships only the `/request-otp` path. `/verify-otp` +
 * `/refresh` land in the next slice once the refresh-token repo and
 * wiring are in place.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  createOtp,
  generateOtpCode,
  countRecentOtpsForEmail,
  OTP_REQUESTS_PER_EMAIL_PER_MINUTE,
} from './otps.js';
import { getEmailProvider } from './email.js';

const log = logger.child({ handler: 'auth-native' });

const RequestOtpBody = z.object({
  email: z.string().email(),
  // Platform is forwarded only so the response envelope matches the
  // CTX proxy's; the native path doesn't consume it today.
  platform: z.enum(['web', 'ios', 'android']).default('web'),
});

/**
 * POST /api/auth/request-otp — native path.
 *
 * Always returns 200 with `{ message: 'Verification code sent' }`
 * regardless of whether the email is known or whether the email
 * provider succeeded — email-enumeration defence, same shape the
 * CTX-proxy path already uses.
 *
 * Per-email cap on top of the per-IP rate limit: an attacker
 * rotating IPs can't still flood one inbox.
 */
export async function nativeRequestOtpHandler(c: Context): Promise<Response> {
  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }
  const email = parsed.data.email.toLowerCase().trim();

  try {
    const recent = await countRecentOtpsForEmail({ email, windowMs: 60_000 });
    if (recent >= OTP_REQUESTS_PER_EMAIL_PER_MINUTE) {
      // Same-shape response: don't tell the caller they tripped the
      // per-email cap. The per-IP limiter already returns a 429 with
      // Retry-After; this branch handles rotated-IP attacks silently.
      log.warn({ email }, 'OTP request skipped — per-email cap hit');
      return c.json({ message: 'Verification code sent' });
    }

    const code = generateOtpCode();
    const { expiresAt } = await createOtp({ email, code });

    try {
      await getEmailProvider().sendOtpEmail({ to: email, code, expiresAt });
    } catch (err) {
      // The OTP row is already written. If the email send fails the
      // user won't receive the code; they'll hit `request-otp` again
      // and land on a fresh row. Log at error so on-call notices a
      // provider incident; do not surface the failure to the client
      // (enumeration defence).
      log.error({ err, email }, 'OTP email send failed');
    }

    return c.json({ message: 'Verification code sent' });
  } catch (err) {
    log.error({ err, email }, 'Native request-otp failed unexpectedly');
    // Surface a 500 on DB failures so the client can back off. A
    // malicious caller learns nothing beyond "backend is unwell".
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to send verification code' }, 500);
  }
}
