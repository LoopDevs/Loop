import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'auth' });

const RequestOtpBody = z.object({ email: z.string().email() });
const VerifyOtpBody = z.object({ email: z.string().email(), otp: z.string().min(1) });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });

// Upstream response schemas — validate before forwarding to client
const VerifyOtpUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const RefreshUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
});

function upstreamUrl(path: string): string {
  return `${env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '')}${path}`;
}

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
    const response = await fetch(upstreamUrl('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: parsed.data.email }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error({ status: response.status, body }, 'Upstream login request failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to send verification code' }, 502);
    }

    return c.json({ message: 'Verification code sent' });
  } catch (err) {
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
    const response = await fetch(upstreamUrl('/verify-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: parsed.data.email, code: parsed.data.otp }),
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
    const response = await fetch(upstreamUrl('/refresh-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: parsed.data.refreshToken }),
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
