import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';

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

// Upstream response schemas — validate before forwarding to client
const VerifyOtpUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const RefreshUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
});

/**
 * POST /api/auth/request-otp
 * Proxies to upstream POST /login.
 */
export async function requestOtpHandler(c: Context): Promise<Response> {
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
      const body = (await response.text()).slice(0, 500);
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
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err }, 'Auth proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to send verification code' }, 500);
  }
}

/**
 * POST /api/auth/verify-otp
 * Proxies to upstream POST /verify-email.
 * Maps { email, otp } → { email, code } for upstream.
 */
export async function verifyOtpHandler(c: Context): Promise<Response> {
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
      const body = (await response.text()).slice(0, 500);
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
 * Proxies to upstream POST /refresh-token.
 */
export async function refreshHandler(c: Context): Promise<Response> {
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
      const body = (await response.text()).slice(0, 500);
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
 * Middleware: extracts Bearer token from Authorization header.
 * Does not verify the token — upstream validates on each proxied call.
 * Sets c.set('bearerToken', token) for downstream handlers.
 */
export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  c.set('bearerToken', token);

  // Forward X-Client-Id if present — CTX uses this to determine entity context
  const clientId = c.req.header('X-Client-Id');
  if (clientId) {
    c.set('clientId', clientId);
  }

  await next();
}
