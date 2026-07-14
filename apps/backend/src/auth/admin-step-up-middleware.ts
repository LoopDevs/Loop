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
 *     replaying admin A's step-up against admin B's session). Checked
 *     on the stateless verify BEFORE the single-use consume, so a
 *     mismatched-subject presentation burns nothing.
 *   - Scope mismatch (CF-08 / SEC-02-stepup): the token's `scope` is a
 *     DIFFERENT class than the `action` this gate guards → 401
 *     `STEP_UP_PURPOSE_MISMATCH`. There is NO wildcard bypass: a
 *     wildcard-scoped token does NOT satisfy a concrete gate (that was
 *     the audited all-class privilege). `consumeAdminStepUpToken`
 *     enforces this.
 *   - Already consumed (SEC-02-stepup): step-up tokens are SINGLE-USE.
 *     A second presentation of the same token → 401
 *     `STEP_UP_ALREADY_USED`. The UI re-mints a fresh scoped token.
 *   - Not consumable (SEC-02-stepup): a legacy `jti`-less token can't
 *     be tracked single-use → 401 `STEP_UP_INVALID` (fail closed).
 *   - Backend not configured (`LOOP_ADMIN_STEP_UP_SIGNING_KEY`
 *     unset) → 503 `STEP_UP_UNAVAILABLE`. Fail closed: surface
 *     ships disabled if the operator hasn't generated the key.
 *
 * SEC-02-stepup: the gate CONSUMES rather than merely verifies. The
 * stateless verify (`verifyAdminStepUpToken`) still runs first to pin
 * the subject; the authoritative authorisation decision — this class,
 * once — goes through `consumeAdminStepUpToken`, which is DB-backed
 * (`admin_step_up_consumptions`).
 *
 * The middleware requires a Loop-native auth subject to pin the
 * step-up token against. Legacy CTX-proxy bearer context has no
 * Loop user id, so it fails closed here rather than acting as a
 * standalone admin-write gate.
 */
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

/**
 * Returns the middleware handler. Exported as a factory rather than a
 * direct middleware export so the per-action scope binding flows
 * through configuration without changing the import shape.
 *
 * @param action — the action class this gate guards. REQUIRED
 *   (SEC-02-stepup): the token must have been minted for exactly this
 *   class, and is consumed single-use against it. There is no longer a
 *   scope-agnostic mode — the old "accept any narrow scope / wildcard"
 *   behaviour WAS the audited all-class privilege.
 */
export function requireAdminStepUp(action: AdminStepUpScope): MiddlewareHandler {
  const mw: MiddlewareHandler = async (c: Context, next) => {
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

    // Hardening B2: fail closed when there is no authenticated
    // context to pin the step-up token's subject against. The gate
    // is designed to mount AFTER requireAuth + requireStaff; if a
    // future mount drops those, the subject-pinning check below
    // would silently no-op and ANY admin's valid step-up token would
    // satisfy the gate. A missing auth context is a mount-order bug,
    // not a client error — reject rather than trust.
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

    // Stateless verify FIRST — purely to pin the subject before the
    // single-use consume. Doing subject-pinning here (rather than after
    // consume) means a token presented on the WRONG admin's session is
    // rejected without being burned, so a leaked-token replay can't DoS
    // the legitimate owner's freshly-minted token.
    const verified: AdminStepUpVerifyResult = verifyAdminStepUpToken(tokenHeader);
    if (!verified.ok) {
      log.warn({ reason: verified.reason }, 'admin step-up token rejected (verify)');
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
    // session — sidestepping the per-admin freshness check. The
    // auth context is guaranteed non-undefined by the fail-closed
    // check above (B2), so this comparison is unconditional.
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

    // SEC-02-stepup: the authoritative authorisation decision. Consume
    // the token DB-backed against this gate's concrete action: it must
    // have been minted for exactly this class (no wildcard bypass) and
    // it is burned single-use. A scope mismatch is rejected before the
    // insert (nothing burned); a replay of an already-consumed token
    // conflicts on the `jti` primary key.
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
      // `not_consumable` (legacy jti-less token → fail closed) plus any
      // stateless reason that slipped past the verify above.
      return c.json(
        {
          code: 'STEP_UP_INVALID',
          message: 'Step-up authentication is invalid or expired. Re-confirm your password.',
        },
        401,
      );
    }

    // Stash the consumed claims on the request context — the audit
    // middleware reads `stepUp` to populate the audit row's
    // `step_up_at` column.
    c.set('stepUp', consumed.claims);
    return next();
  };
  // Named so the route-inventory test (staff-route-gating.test.ts)
  // can statically assert every destructive admin mount declares its
  // step-up gate + scope — same pattern as `requireStaff`. Hardening
  // B1: before this, the gate was an anonymous closure the inventory
  // walk couldn't see, so a new money-write route missing step-up
  // passed every structural test.
  Object.defineProperty(mw, 'name', { value: `requireAdminStepUp(${action})` });
  return mw;
}
