import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { nativeRequestOtpHandler, nativeVerifyOtpHandler, nativeRefreshHandler } from './native.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
import { revokeRefreshToken } from './refresh-tokens.js';

const log = logger.child({ handler: 'auth' });

const PlatformEnum = z.enum(['web', 'ios', 'android']).default('web');
const RequestOtpBody = z.object({ email: z.string().email(), platform: PlatformEnum });
const VerifyOtpBody = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
  platform: PlatformEnum,
});
const RefreshBody = z.object({ refreshToken: z.string().min(1), platform: PlatformEnum });

/** Maps platform to the upstream CTX client ID. */
function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return env.CTX_CLIENT_ID_IOS;
  if (platform === 'android') return env.CTX_CLIENT_ID_ANDROID;
  return env.CTX_CLIENT_ID_WEB;
}

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

// Upstream response schemas — validate before forwarding to client.
// A2-1706: exported so the contract-test suite can parse recorded
// CTX fixtures through them at PR-time.
export const VerifyOtpUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const RefreshUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
});

/**
 * POST /api/auth/request-otp
 *
 * Proxies to upstream POST /login by default. When
 * `LOOP_AUTH_NATIVE_ENABLED` is set (ADR 013), dispatches to the
 * Loop-native handler which sends the email itself and writes an
 * `otps` row — CTX is bypassed for user identity.
 */
export async function requestOtpHandler(c: Context): Promise<Response> {
  if (env.LOOP_AUTH_NATIVE_ENABLED) {
    return nativeRequestOtpHandler(c);
  }

  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }

  try {
    const response = await getUpstreamCircuit('login').fetch(upstreamUrl('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: parsed.data.email,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // Truncate the body before logging — pino redact only matches structured
      // field names, so if an upstream ever echoed a token in an error string
      // it would slip through. Cap at 500 chars to keep logs parseable.
      const body = scrubUpstreamBody(await response.text());
      log.error({ status: response.status, body }, 'Upstream login request failed');
      // Enumeration defense: return 200 with a generic message for 4xx from upstream
      // (e.g. "no such user") so an attacker cannot distinguish valid vs invalid emails.
      // Still surface infrastructure failures (5xx) so legitimate users are not left waiting.
      if (response.status >= 400 && response.status < 500) {
        return c.json({ message: 'Verification code sent' });
      }
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to send verification code' }, 502);
    }

    return c.json({ message: 'Verification code sent' });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // A2-558: the enumeration-defense envelope above flattens every
      // upstream outcome (200 success, 4xx "no such user") into a
      // uniform `{ message: 'Verification code sent' }`. A 503 here
      // would re-open that sidechannel — an attacker probing the
      // endpoint could distinguish "circuit open" (service down)
      // from "any other state". Return the same generic 200 envelope
      // so the response shape is invariant w.r.t. backend state.
      // Log so ops still sees the circuit-open event.
      log.warn('request-otp upstream circuit open — returning generic 200 envelope');
      return c.json({ message: 'Verification code sent' });
    }
    log.error({ err }, 'Auth proxy error');
    // Same rationale as the CircuitOpen branch above — an INTERNAL
    // 500 would also leak the backend state to an enumeration
    // probe. Collapse to the generic 200. Users who genuinely typed
    // their email will just not receive a code; logs catch the error.
    return c.json({ message: 'Verification code sent' });
  }
}

/**
 * POST /api/auth/verify-otp
 *
 * Proxies to upstream POST /verify-email by default. With
 * `LOOP_AUTH_NATIVE_ENABLED`, dispatches to the Loop-native handler
 * which consumes a local OTP row, upserts the user, and mints a
 * Loop-signed token pair.
 */
export async function verifyOtpHandler(c: Context): Promise<Response> {
  if (env.LOOP_AUTH_NATIVE_ENABLED) {
    return nativeVerifyOtpHandler(c);
  }

  const parsed = VerifyOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
  }

  try {
    const response = await getUpstreamCircuit('verify-email').fetch(upstreamUrl('/verify-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: parsed.data.email,
        code: parsed.data.otp,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 400) {
        return c.json(
          { code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' },
          401,
        );
      }
      // Log body for schema-drift debugging. Truncate: pino redact is
      // field-based so an upstream echoing a token string would leak
      // through the body verbatim.
      const body = scrubUpstreamBody(await response.text());
      log.error({ status, body }, 'Upstream verify request failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Verification failed' }, 502);
    }

    const raw = await response.json();
    const validated = VerifyOtpUpstreamResponse.safeParse(raw);
    if (!validated.success) {
      log.error(
        { issues: validated.error.issues },
        'Upstream verify response did not match expected shape',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from auth provider' },
        502,
      );
    }
    return c.json(validated.data);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err }, 'Verify proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

/**
 * POST /api/auth/refresh
 *
 * Proxies to upstream POST /refresh-token by default. With
 * `LOOP_AUTH_NATIVE_ENABLED`, dispatches to the Loop-native handler
 * which verifies the Loop-signed refresh JWT, checks the
 * `refresh_tokens` row is live + hash-matches, rotates, and returns
 * a new Loop-signed pair.
 */
export async function refreshHandler(c: Context): Promise<Response> {
  if (env.LOOP_AUTH_NATIVE_ENABLED) {
    return nativeRefreshHandler(c);
  }

  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'refreshToken is required' }, 400);
  }

  try {
    const response = await getUpstreamCircuit('refresh-token').fetch(
      upstreamUrl('/refresh-token'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: parsed.data.refreshToken,
          clientId: clientIdForPlatform(parsed.data.platform),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      // 400/401/403 → refresh token is genuinely invalid/expired; the client
      // should drop session and re-auth. Anything else (5xx, 429, etc.) is an
      // upstream problem — returning 401 here would tell a user with a
      // perfectly good token that they've been "logged out" on every
      // transient upstream blip. Surface it as UPSTREAM_ERROR instead so the
      // client can retry.
      const status = response.status;
      if (status === 400 || status === 401 || status === 403) {
        log.info({ status }, 'Upstream rejected refresh token');
        return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' }, 401);
      }
      // Only read the body for debug-logging on unexpected statuses. Reading
      // unconditionally wastes work on the hot path.
      const body = scrubUpstreamBody(await response.text());
      log.error({ status, body }, 'Upstream refresh request failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Token refresh failed' }, 502);
    }

    const raw = await response.json();
    const validated = RefreshUpstreamResponse.safeParse(raw);
    if (!validated.success) {
      log.error(
        { issues: validated.error.issues },
        'Upstream refresh response did not match expected shape',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from auth provider' },
        502,
      );
    }
    return c.json(validated.data);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err }, 'Refresh proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Token refresh failed' }, 500);
  }
}

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  platform: PlatformEnum,
});

/**
 * DELETE /api/auth/session — best-effort upstream revoke + success.
 *
 * If the client supplies a refresh token we try to revoke it upstream so a
 * leaked token can't outlive the user's intent to log out. Upstream errors
 * are logged and swallowed: the client has already decided to log out, so
 * failing the request would just trap the token in-store. The client
 * always clears local state on receiving 200.
 */
export async function logoutHandler(c: Context): Promise<Response> {
  const parsed = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.refreshToken === undefined) {
    // No token in body — nothing to revoke upstream. Still succeed so the
    // client proceeds with local clear.
    return c.json({ message: 'Logged out' });
  }

  // A2-565: when the refresh token is Loop-signed, revoke the row so
  // the 30-day TTL doesn't keep it live server-side. Do this before
  // the upstream call — if upstream throws, we still want the local
  // revoke to have happened. verifyLoopToken ignores tokens from
  // other issuers / audiences (A2-1600), so a CTX-signed bearer
  // falls through harmlessly.
  if (isLoopAuthConfigured()) {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (verified.ok && verified.claims.jti !== undefined) {
      try {
        await revokeRefreshToken({ jti: verified.claims.jti });
      } catch (err) {
        // Revocation failure is not fatal — the signed token still
        // expires at its exp regardless. Log and continue so the
        // upstream call still gets made.
        log.warn({ err, jti: verified.claims.jti }, 'Loop refresh-token revocation failed');
      }
    }
  }

  try {
    const response = await getUpstreamCircuit('logout').fetch(upstreamUrl('/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: parsed.data.refreshToken,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status },
        'Upstream logout returned non-success — token may still be valid upstream',
      );
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      // Upstream unreachable — client still gets its local clear.
      log.info('Logout attempted while upstream circuit open');
    } else {
      log.warn({ err }, 'Logout upstream call failed');
    }
  }

  return c.json({ message: 'Logged out' });
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
