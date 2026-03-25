import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { upstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
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
    const response = await upstreamCircuit.fetch(upstreamUrl('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: parsed.data.email,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error({ status: response.status, body }, 'Upstream login request failed');
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
    const response = await upstreamCircuit.fetch(upstreamUrl('/verify-email'), {
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
    const response = await upstreamCircuit.fetch(upstreamUrl('/refresh-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: parsed.data.refreshToken,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' }, 401);
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

/** DELETE /api/auth/session — client clears tokens locally. */
export function logoutHandler(c: Context): Response {
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
  await next();
}
