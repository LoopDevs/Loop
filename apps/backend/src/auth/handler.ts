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
// A2-803 (auth slice): request-body schemas live in the shared
// `request-schemas.ts` module so both this CTX-proxy path and the
// Loop-native path (`native.ts`) verify against the same source.
import { PlatformEnum, RequestOtpBody, VerifyOtpBody, RefreshBody } from './request-schemas.js';
import { notifyCtxSchemaDrift } from '../discord.js';

/**
 * A2-1915: condense a Zod issue array into a compact one-line
 * summary suitable for a Discord embed field.
 */
function summariseZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

const log = logger.child({ handler: 'auth' });

/** Maps platform to the upstream CTX client ID. */
function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return env.CTX_CLIENT_ID_IOS;
  if (platform === 'android') return env.CTX_CLIENT_ID_ANDROID;
  return env.CTX_CLIENT_ID_WEB;
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
      notifyCtxSchemaDrift({
        surface: 'POST /verify-email',
        issuesSummary: summariseZodIssues(validated.error.issues),
      });
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
      notifyCtxSchemaDrift({
        surface: 'POST /refresh-token',
        issuesSummary: summariseZodIssues(validated.error.issues),
      });
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

// `requireAuth` middleware + `LoopAuthContext` type live in
// `./require-auth.ts`. Re-exported here so the wide network of
// existing import sites (eight test files, multiple handlers)
// keeps working without re-targeting.
export { requireAuth, type LoopAuthContext } from './require-auth.js';
