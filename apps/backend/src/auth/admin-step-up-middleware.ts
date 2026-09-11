// requireAdminStepUp middleware — ADR 028, A4-063, SEC-02-stepup
import type { Context, MiddlewareHandler } from 'hono';
import {
  isAdminStepUpConfigured,
  verifyAdminStepUpToken,
  consumeAdminStepUpToken,
  type AdminStepUpScope,
  type AdminStepUpVerifyResult,
  type AdminStepUpConsumeResult,
} from './admin-step-up.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'admin-step-up' });

interface AuthLike {
  kind: 'loop' | 'ctx';
  userId?: string | undefined;
}

export function requireAdminStepUp(action: AdminStepUpScope): MiddlewareHandler {
  const mw: MiddlewareHandler = async (c: Context, next) => {
    if (!isAdminStepUpConfigured()) {
      log.error('admin step-up gate hit but no JWT signing key is configured');
      return c.json(
        {
          code: 'STEP_UP_UNAVAILABLE',
          message:
            'Admin step-up auth is not configured on this deployment. Set auth.native.jwt.current and redeploy.',
        },
        503,
      );
    }

    const auth = c.get('auth') as AuthLike | undefined;

    // Fail closed on missing auth context: prevents a mount-order bug from allowing any admin's
    // valid step-up token to satisfy the gate.
    if (auth === undefined || auth.userId === undefined) {
      log.error(
        { path: c.req.path },
        'step-up gate reached without an authenticated context — mount-order bug; failing closed',
      );
      return c.json(
        {
          code: 'STEP_UP_INVALID',
          message: 'Step-up authentication could not be verified for this session.',
        },
        401,
      );
    }

    const tokenHeader = c.req.header('X-Admin-Step-Up') ?? c.req.header('x-admin-step-up');
    if (tokenHeader === undefined || tokenHeader.length === 0) {
      return c.json(
        {
          code: 'STEP_UP_REQUIRED',
          message: 'This action requires step-up authentication. Re-confirm your password.',
        },
        401,
      );
    }

    // Verify before consume: pins subject without burning the token, so a replay on the wrong
    // session cannot DoS the legitimate owner.
    const verified: AdminStepUpVerifyResult = verifyAdminStepUpToken(tokenHeader);
    if (!verified.ok) {
      log.warn({ reason: verified.reason }, 'admin step-up token rejected (verify)');
      return c.json(
        {
          code: 'STEP_UP_INVALID',
          message: 'Step-up authentication is invalid or expired. Re-confirm your password.',
        },
        401,
      );
    }

    // Subject pinning: prevents admin A's step-up token from being replayed on admin B's session.
    if (verified.claims.sub !== auth.userId) {
      log.warn(
        { stepUpSub: verified.claims.sub, bearerSub: auth.userId },
        'admin step-up subject mismatch',
      );
      return c.json(
        {
          code: 'STEP_UP_SUBJECT_MISMATCH',
          message: 'Step-up token belongs to a different admin session.',
        },
        401,
      );
    }

    // SEC-02-stepup: DB-backed consume enforces single-use and exact scope match (no wildcard bypass).
    const consumed: AdminStepUpConsumeResult = await consumeAdminStepUpToken({
      token: tokenHeader,
      action,
    });
    if (!consumed.ok) {
      log.warn(
        { reason: consumed.reason, requiredAction: action },
        'admin step-up token rejected (consume)',
      );
      if (consumed.reason === 'scope_mismatch') {
        return c.json(
          {
            code: 'STEP_UP_PURPOSE_MISMATCH',
            message: 'Step-up token was confirmed for a different action. Re-confirm to continue.',
          },
          401,
        );
      }
      if (consumed.reason === 'already_consumed') {
        return c.json(
          {
            code: 'STEP_UP_ALREADY_USED',
            message: 'Step-up token was already used. Re-confirm to continue.',
          },
          401,
        );
      }
      return c.json(
        {
          code: 'STEP_UP_INVALID',
          message: 'Step-up authentication is invalid or expired. Re-confirm your password.',
        },
        401,
      );
    }

    // Stash consumed claims for audit middleware to populate `step_up_at`.
    c.set('stepUp', consumed.claims);
    return next();
  };
  // Named so route-inventory tests can statically assert every destructive admin mount declares its step-up gate + scope.
  Object.defineProperty(mw, 'name', { value: `requireAdminStepUp(${action})` });
  return mw;
}
