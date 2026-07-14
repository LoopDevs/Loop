/**
 * `POST /api/admin/step-up` — mint a 5-minute step-up JWT (ADR 028, A4-063).
 *
 * Re-verifies the admin's identity beyond the bearer token, then mints
 * a token the admin presents as `X-Admin-Step-Up` on the gated
 * destructive endpoints. The bearer token alone is insufficient by
 * design — see `auth/admin-step-up-middleware.ts`.
 *
 * Phase-1 supports `kind: 'otp'` only. The admin requests an OTP via
 * the existing `POST /api/auth/request-otp` flow, then POSTs the OTP
 * here. Rationale: every admin already has the OTP path wired (it's
 * how they signed in); password-only admins don't exist on Loop, and
 * social-login admins can re-prompt via the standard OAuth re-auth
 * flow once the OTP path is settled. ADR-028 §Phase-2 expands to
 * password / WebAuthn variants.
 *
 * Mounting: this endpoint sits under `/api/admin/*` so the standard
 * admin middleware stack (cache-control / requireAuth / requireAdmin /
 * audit) applies — only authenticated admins can mint step-up tokens.
 * The audit middleware records the step-up issuance as a read-side
 * event; the destructive write that consumes the token records its
 * own audit row separately.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  isAdminStepUpConfigured,
  signAdminStepUpToken,
  STEP_UP_SCOPES,
} from '../auth/admin-step-up.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { findLiveOtp, incrementOtpAttempts, tryConsumeOtp } from '../auth/otps.js';
import { normalizeEmail, NonAsciiEmailError } from '../auth/normalize-email.js';
import {
  clearOtpAttempts,
  isEmailOtpLocked,
  OTP_EMAIL_LOCKOUT_MS,
  registerFailedOtpAttempt,
} from '../auth/otp-attempt-counter.js';

const log = logger.child({ handler: 'admin-step-up' });

const StepUpBody = z.object({
  /** OTP code the admin received via `POST /api/auth/request-otp`. */
  otp: z.string().min(1).max(20),
  /** Reserved for ADR-028 Phase-2 (password / webauthn variants). */
  kind: z.literal('otp').optional().default('otp'),
  /**
   * SEC-02-stepup: REQUIRED action class to bind the minted token to.
   * Was optional-defaulting-to-wildcard (CF-08); that wildcard default
   * was the audited all-class privilege — the gate now rejects a
   * wildcard against a concrete action, and every web caller mints a
   * fresh token scoped to exactly the write it's about to perform. So
   * the mint requires the class up front (fail-closed / least-privilege).
   */
  scope: z.enum(STEP_UP_SCOPES),
});

export async function adminStepUpHandler(c: Context): Promise<Response> {
  if (!isAdminStepUpConfigured()) {
    log.error('admin step-up requested but LOOP_ADMIN_STEP_UP_SIGNING_KEY is unset');
    return c.json(
      {
        code: 'STEP_UP_UNAVAILABLE',
        message:
          'Admin step-up auth is not configured on this deployment. Generate LOOP_ADMIN_STEP_UP_SIGNING_KEY and redeploy.',
      },
      503,
    );
  }

  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    // ADR-028 step-up is a Loop-native-only surface. CTX-proxy
    // sessions have no Loop-native subject to pin the step-up token
    // to, so fail closed.
    return c.json(
      { code: 'UNAUTHORIZED', message: 'Loop-native authentication required for admin step-up' },
      401,
    );
  }

  const parsed = StepUpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'otp is required' }, 400);
  }

  let email: string;
  try {
    email = normalizeEmail(auth.email);
  } catch (err) {
    if (err instanceof NonAsciiEmailError) {
      // The admin's stored email isn't ascii-normalisable — same
      // generic 401 as a wrong OTP so step-up doesn't leak the
      // admin's email shape.
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    throw err;
  }

  try {
    if (await isEmailOtpLocked({ email })) {
      c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
      return c.json(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
        429,
      );
    }
    const hit = await findLiveOtp({ email, code: parsed.data.otp });
    if (hit === null) {
      await incrementOtpAttempts({ email });
      const { locked } = await registerFailedOtpAttempt({ email });
      if (locked) {
        c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
        return c.json(
          { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
          429,
        );
      }
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    // BK-otpatomic-stepup: consume the OTP with the atomic compare-and-set
    // (`consumed_at IS NULL → now()` in one UPDATE) rather than the
    // read-then-mark `findLiveOtp` + `markOtpConsumed` pair, which raced:
    // two concurrent step-up requests presenting the same live OTP both
    // observed it unconsumed and both minted a token. `tryConsumeOtp`
    // makes exactly one caller win; the loser is rejected as if the code
    // were already spent (single-use OTP).
    const won = await tryConsumeOtp(hit.id);
    if (!won) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    await clearOtpAttempts(email);
    const { token, claims } = signAdminStepUpToken({
      sub: auth.userId,
      email,
      // SEC-02-stepup: scope is REQUIRED — bind the token to exactly the
      // action class the caller declared. No wildcard fallback.
      scope: parsed.data.scope,
    });
    log.info(
      { adminId: auth.userId, expSec: claims.exp, scope: claims.scope },
      'admin step-up token issued',
    );
    return c.json({
      stepUpToken: token,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    });
  } catch (err) {
    log.error({ err, adminId: auth.userId }, 'admin step-up unexpected failure');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Step-up failed' }, 500);
  }
}
