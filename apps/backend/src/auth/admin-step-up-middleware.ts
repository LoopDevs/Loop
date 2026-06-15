/**
 * `requireAdminStepUp` middleware (ADR 028, A4-063).
 *
 * Gates a destructive admin endpoint on a fresh `X-Admin-Step-Up`
 * JWT. Sits AFTER `requireAuth` + `requireAdmin` in the middleware
 * stack — admin authn is ADR-013's bearer + ADR-017's allowlist;
 * this layer adds an authentication-freshness check on top so that
 * a compromised/cached bearer token alone is insufficient.
 *
 * Failure modes:
 *
 *   - Missing header → 401 `STEP_UP_REQUIRED` (admin UI prompts
 *     password re-entry, mints a step-up token, replays the
 *     request with the header set).
 *   - Malformed / wrong signature / expired / wrong audience →
 *     401 `STEP_UP_INVALID` (UI surfaces "step-up token expired,
 *     please re-confirm").
 *   - Subject mismatch (step-up token's `sub` ≠ bearer token's
 *     `sub`) → 401 `STEP_UP_SUBJECT_MISMATCH` (defends against
 *     replaying admin A's step-up against admin B's session).
 *   - Scope mismatch (CF-08): the gate was mounted with a specific
 *     `action` but the token's `scope` is a *different* narrow scope
 *     → 401 `STEP_UP_PURPOSE_MISMATCH`. A wildcard-scoped token
 *     (`'admin-write'`, the mint default) satisfies any action, so
 *     this only fires when an admin deliberately narrowed a token to
 *     one class and then replayed it against another class.
 *   - Backend not configured (`LOOP_ADMIN_STEP_UP_SIGNING_KEY`
 *     unset) → 503 `STEP_UP_UNAVAILABLE`. Fail closed: surface
 *     ships disabled if the operator hasn't generated the key.
 *
 * The middleware does NOT check that the bearer kind is `loop` —
 * admins authenticated via the legacy CTX-proxy path are exempt
 * from step-up by design (ADR-028 §Excluded). When ADR-013 Phase
 * C lands and the CTX-proxy path is removed, this exemption goes
 * with it.
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  isAdminStepUpConfigured,
  verifyAdminStepUpToken,
  STEP_UP_SCOPE_WILDCARD,
  type AdminStepUpScope,
  type AdminStepUpVerifyResult,
} from './admin-step-up.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'admin-step-up' });

interface AuthLike {
  kind: 'loop' | 'ctx';
  userId?: string | undefined;
}

/**
 * Returns the middleware handler. Exported as a factory rather than a
 * direct middleware export so the per-action scope binding (CF-08)
 * flows through configuration without changing the import shape.
 *
 * @param action — CF-08 action class this gate guards. Omitted (the
 *   prior call shape) means "any narrow scope is accepted" — the gate
 *   only verifies freshness, not which class the token was minted for,
 *   so existing mounts keep working unchanged. Pass a specific scope
 *   to additionally require that a *narrowed* token was minted for
 *   exactly this class (a wildcard token still satisfies it).
 */
export function requireAdminStepUp(action?: AdminStepUpScope): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!isAdminStepUpConfigured()) {
      log.error('admin step-up gate hit but LOOP_ADMIN_STEP_UP_SIGNING_KEY is unset');
      return c.json(
        {
          code: 'STEP_UP_UNAVAILABLE',
          message:
            'Admin step-up auth is not configured on this deployment. Generate LOOP_ADMIN_STEP_UP_SIGNING_KEY and redeploy.',
        },
        503,
      );
    }

    const auth = c.get('auth') as AuthLike | undefined;
    // ADR-028 exempts the legacy CTX-proxy path — `kind === 'ctx'`
    // admins fall through (their step-up is whatever CTX itself
    // gates on). Loop-native admins MUST present a step-up token.
    if (auth !== undefined && auth.kind === 'ctx') {
      return next();
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

    const verified: AdminStepUpVerifyResult = verifyAdminStepUpToken(tokenHeader);
    if (!verified.ok) {
      log.warn({ reason: verified.reason }, 'admin step-up token rejected');
      // `not_configured` was caught above; if we got here it's a
      // real verify failure (signature / expiry / wrong audience).
      // Collapse them to a single error code so the UI flow is one
      // branch — re-prompt and replay.
      return c.json(
        {
          code: 'STEP_UP_INVALID',
          message: 'Step-up authentication is invalid or expired. Re-confirm your password.',
        },
        401,
      );
    }

    // Subject pinning: the step-up token's `sub` MUST match the
    // bearer access token's `sub`. Otherwise admin A could mint a
    // step-up, hand the token to admin B, and B replays it on their
    // session — sidestepping the per-admin freshness check.
    if (auth?.userId !== undefined && verified.claims.sub !== auth.userId) {
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

    // CF-08 scope binding. If this gate guards a specific action and
    // the presented token was minted for a *different* narrow scope,
    // reject — a step-up confirmed for (say) a refund must not be
    // silently reusable for a withdrawal. A wildcard-scoped token
    // (`'admin-write'`, the mint default) satisfies every action, so
    // the common "one generic token, replayed across writes" flow is
    // unaffected; this only fires for deliberately-narrowed tokens.
    if (
      action !== undefined &&
      verified.claims.scope !== STEP_UP_SCOPE_WILDCARD &&
      verified.claims.scope !== action
    ) {
      log.warn(
        { tokenScope: verified.claims.scope, requiredAction: action },
        'admin step-up scope mismatch',
      );
      return c.json(
        {
          code: 'STEP_UP_PURPOSE_MISMATCH',
          message: 'Step-up token was confirmed for a different action. Re-confirm to continue.',
        },
        401,
      );
    }

    // Stash the verified claims on the request context — the audit
    // middleware reads `stepUp` to populate the audit row's
    // `step_up_at` column.
    c.set('stepUp', verified.claims);
    return next();
  };
}
