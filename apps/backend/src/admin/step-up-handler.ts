// POST /api/admin/step-up — mint 5-minute step-up JWT — ADR 028, A4-063
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
  otp: z.string().min(1).max(20),
  kind: z.literal('otp').optional().default('otp'),
  // SEC-02-stepup: required to bind token to specific action class (fail-closed)
  scope: z.enum(STEP_UP_SCOPES),
});

export async function adminStepUpHandler(c: Context): Promise<Response> {
  if (!isAdminStepUpConfigured()) {
    log.error('admin step-up requested but no JWT signing key is configured');
    return c.json(
      {
        code: 'STEP_UP_UNAVAILABLE',
        message:
          'Admin step-up auth is not configured on this deployment. Set auth.native.jwt.current and redeploy.',
      },
      503,
    );
  }

  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    // ADR-028: Loop-native only; CTX-proxy has no subject to pin
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
      // Return generic 401 to avoid leaking email shape
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
    // BK-otpatomic-stepup: atomic consume prevents race where concurrent requests both mint tokens
    const won = await tryConsumeOtp(hit.id);
    if (!won) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    await clearOtpAttempts(email);
    const { token, claims } = signAdminStepUpToken({
      sub: auth.userId,
      email,
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
