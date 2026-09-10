import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { nativeRequestOtpHandler, nativeVerifyOtpHandler, nativeRefreshHandler } from './native.js';
// A2-803 (auth slice): shared schemas ensure CTX-proxy and Loop-native paths verify against the same source.
import { RequestOtpBody, VerifyOtpBody, RefreshBody } from './request-schemas.js';
import { notifyCtxSchemaDrift } from '../discord.js';

// A2-1915
function summariseZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

const log = logger.child({ handler: 'auth' });

function clientIdForPlatform(platform: 'web' | 'ios' | 'android'): string {
  if (platform === 'ios') return config.ctx.clientIds.ios;
  if (platform === 'android') return config.ctx.clientIds.android;
  return config.ctx.clientIds.web;
}

// A2-1706: exported for contract-test suite to parse recorded CTX fixtures.
export const VerifyOtpUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const RefreshUpstreamResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
});

// ADR 013
export async function requestOtpHandler(c: Context): Promise<Response> {
  if (config.auth.native.enabled) {
    return nativeRequestOtpHandler(c);
  }

  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }

  try {
    const response = await upstreamFetch(upstreamUrl('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: parsed.data.email,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // pino redact is field-based; scrub prevents token leakage if upstream echoes secrets in error strings.
      const body = scrubUpstreamBody(await response.text());
      log.error({ status: response.status, body }, 'Upstream login request failed');
      // Enumeration defense: generic 200 for 4xx prevents distinguishing valid vs invalid emails.
      if (response.status >= 400 && response.status < 500) {
        return c.json({ message: 'Verification code sent' });
      }
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to send verification code' }, 502);
    }

    return c.json({ message: 'Verification code sent' });
  } catch (err) {
    log.error({ err }, 'Auth proxy error');
    // A2-558: invariant response shape prevents sidechannel distinguishing "upstream down" from other states.
    return c.json({ message: 'Verification code sent' });
  }
}

export async function verifyOtpHandler(c: Context): Promise<Response> {
  if (config.auth.native.enabled) {
    return nativeVerifyOtpHandler(c);
  }

  const parsed = VerifyOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
  }

  try {
    const response = await upstreamFetch(upstreamUrl('/verify-email'), {
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
      // pino redact is field-based; scrub prevents token leakage.
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
    log.error({ err }, 'Verify proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

export async function refreshHandler(c: Context): Promise<Response> {
  if (config.auth.native.enabled) {
    return nativeRefreshHandler(c);
  }

  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'refreshToken is required' }, 400);
  }

  try {
    const response = await upstreamFetch(upstreamUrl('/refresh-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: parsed.data.refreshToken,
        clientId: clientIdForPlatform(parsed.data.platform),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // 400/401/403 indicate invalid token; other statuses are upstream issues.
      const status = response.status;
      if (status === 400 || status === 401 || status === 403) {
        log.info({ status }, 'Upstream rejected refresh token');
        return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' }, 401);
      }
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
    log.error({ err }, 'Refresh proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Token refresh failed' }, 500);
  }
}

export { logoutHandler } from './logout-handler.js';

export { requireAuth, type LoopAuthContext } from './require-auth.js';
