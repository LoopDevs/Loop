/**
 * Per-request authentication middleware (`requireAuth`) +
 * `LoopAuthContext` shape it sets on the Hono context.
 *
 * Lifted out of `apps/backend/src/auth/handler.ts` to separate
 * the per-request auth check from the `/api/auth/*` route
 * handlers (request-otp / verify-otp / refresh / logout). The
 * middleware needs to be cheap and pure (no DB or upstream calls
 * outside the JWT verify), and lives next to the token /
 * refresh-token primitives it composes.
 *
 * `LoopAuthContext` is re-exported from `auth/handler.ts` via the
 * barrel pattern so existing imports across the backend keep
 * working.
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';

const log = logger.child({ handler: 'auth-middleware' });

/**
 * Every client ID we're prepared to forward upstream. Audit A-036 flagged
 * that `requireAuth` previously echoed whatever `X-Client-Id` a client sent
 * straight into the upstream CTX request, so a compromised client could
 * pick an arbitrary entity context. Restrict to the three values we set at
 * auth time (web / ios / android), resolved from the same env vars used
 * by `clientIdForPlatform`.
 */
function allowedClientIds(): ReadonlySet<string> {
  return new Set([env.CTX_CLIENT_ID_WEB, env.CTX_CLIENT_ID_IOS, env.CTX_CLIENT_ID_ANDROID]);
}

/**
 * Shape set on the Hono context by `requireAuth` — tells downstream
 * handlers whether the user authenticated with a Loop-signed token
 * or a legacy CTX-signed bearer.
 *
 * During the ADR 013 migration both are accepted. Handlers that need
 * to decide whether to hit CTX directly with the bearer (legacy
 * path) or route via the operator pool (Loop-native path) branch
 * on `kind`.
 */
export type LoopAuthContext =
  | {
      kind: 'loop';
      userId: string;
      email: string;
      /** Loop-signed access JWT. Not forwardable to CTX. */
      bearerToken: string;
    }
  | {
      kind: 'ctx';
      /** Legacy CTX-signed bearer — forwarded upstream verbatim. */
      bearerToken: string;
    };

/**
 * Middleware: authenticates the request.
 *
 * During the ADR 013 migration this accepts either a Loop-signed
 * access token (verified in-process against `LOOP_JWT_SIGNING_KEY`)
 * or a legacy CTX-signed bearer (pass-through: CTX validates on
 * each proxied call).
 *
 * On success:
 *   - `c.set('auth', LoopAuthContext)` — full discriminated union,
 *     the preferred API for new handlers.
 *   - `c.set('bearerToken', token)` — raw bearer, preserved for
 *     existing CTX-proxy handlers that forward it upstream.
 *   - `c.set('clientId', platform)` when a trusted `X-Client-Id` is
 *     present.
 *
 * A Loop token whose signature verifies but is expired / wrong-typ
 * gets a specific 401. A string that's neither a valid Loop token
 * nor a plausible CTX JWT still gets the same 401 — we don't leak
 * which kind of auth is configured.
 */
export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  // Try Loop-signed JWT first — cheap in-process verify, no network.
  // If the signing key isn't configured we can't accept Loop tokens,
  // so the CTX pass-through is the only remaining path.
  if (isLoopAuthConfigured()) {
    const verified = verifyLoopToken(token, 'access');
    if (verified.ok) {
      const authCtx: LoopAuthContext = {
        kind: 'loop',
        userId: verified.claims.sub,
        email: verified.claims.email,
        bearerToken: token,
      };
      c.set('auth', authCtx);
      c.set('bearerToken', token);
      await next();
      return;
    }
    // Differentiate "looks like a Loop token but expired / wrong-type"
    // from "this isn't our JWT" — the latter falls through to the CTX
    // path, the former rejects now. A bad signature that happens to
    // parse as a CTX JWT later would be rejected upstream anyway.
    if (verified.reason === 'expired' || verified.reason === 'wrong_type') {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
    }
    // `malformed` / `bad_signature` fall through to the CTX pass-
    // through below; a genuine CTX bearer is malformed as a Loop JWT.
  }

  // CTX pass-through path. We don't verify here — CTX validates on
  // each proxied call. Preserved for the overlap window (ADR 013
  // Phase A); removed in Phase C once all sessions have rotated.
  const ctxAuth: LoopAuthContext = { kind: 'ctx', bearerToken: token };
  c.set('auth', ctxAuth);
  c.set('bearerToken', token);

  // Forward X-Client-Id if present — CTX uses this to determine entity
  // context. Only honor values from the server-side allowlist (audit A-036);
  // an untrusted or unknown value is dropped rather than forwarded, which
  // makes the downstream handler fall back to the default CTX client
  // binding rather than a client-supplied one.
  const clientId = c.req.header('X-Client-Id');
  if (clientId !== undefined && allowedClientIds().has(clientId)) {
    c.set('clientId', clientId);
  } else if (clientId !== undefined) {
    log.warn({ clientId }, 'Rejected untrusted X-Client-Id value on authenticated request');
  }

  await next();
}
