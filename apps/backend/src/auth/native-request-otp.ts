/**
 * Loop-native `POST /api/auth/request-otp` (ADR 013).
 *
 * Lifted out of `./native.ts` so the request side of the
 * Loop-native flow lives separately from the verify + refresh
 * trio. The three handlers share `LOOP_AUTH_NATIVE_ENABLED`
 * gating and the same `request-schemas.ts` source-of-truth, but
 * the handler bodies share no helpers and pulling request-otp
 * into its own file keeps the parent's import surface focused
 * on the token-issuance pair (verify-otp + refresh) that share
 * `issueTokenPair`.
 *
 * Re-exported from `./native.ts` so the dispatcher in
 * `auth/handler.ts` keeps importing from the historical path.
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';
import {
  recordOtpSendFailure,
  recordOtpSendSuccess,
  setOtpDeliveryEnabled,
} from '../runtime-health.js';
import {
  createOtp,
  generateOtpCode,
  countRecentOtpsForEmail,
  OTP_REQUESTS_PER_EMAIL_PER_MINUTE,
} from './otps.js';
import { getEmailProvider } from './email.js';
import { normalizeEmail, NonAsciiEmailError } from './normalize-email.js';
import { RequestOtpBody } from './request-schemas.js';

const log = logger.child({ handler: 'auth-native' });

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
  setOtpDeliveryEnabled(true);
  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }
  let email: string;
  try {
    email = normalizeEmail(parsed.data.email);
  } catch (err) {
    if (err instanceof NonAsciiEmailError) {
      // A2-2002: non-ASCII email rejected after NFKC. Keep the
      // generic "Valid email is required" message — telling the
      // caller "non-ASCII rejected" leaks the validation rule.
      return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
    }
    throw err;
  }

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
      recordOtpSendSuccess();
    } catch (err) {
      // The OTP row is already written. If the email send fails the
      // user won't receive the code; they'll hit `request-otp` again
      // and land on a fresh row. Log at error so on-call notices a
      // provider incident; do not surface the failure to the client
      // (enumeration defence).
      recordOtpSendFailure(err);
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
