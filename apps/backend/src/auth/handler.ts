import type { Context } from 'hono';
import { z } from 'zod';
import { generateOtp, verifyOtp } from './otp.js';
import { sendOtpEmail } from './mailer.js';
import { issueTokenPair, refreshAccessToken, verifyAccessToken } from './jwt.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'auth' });

// ─── Rate limiting ──────────────────────────────────────────────────────────
const OTP_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const OTP_RATE_LIMIT_MAX = 3; // max 3 OTP requests per email per minute

const otpRateMap = new Map<string, { count: number; resetAt: number }>();

function isOtpRateLimited(email: string): boolean {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = otpRateMap.get(key);

  if (entry === undefined || now > entry.resetAt) {
    otpRateMap.set(key, { count: 1, resetAt: now + OTP_RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > OTP_RATE_LIMIT_MAX;
}

/** Redacts an email for safe logging: "foo@bar.com" -> "fo***@bar.com". */
function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (local === undefined || domain === undefined) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

/** Removes expired rate limit entries. Call periodically. */
export function evictExpiredRateLimits(): void {
  const now = Date.now();
  for (const [key, entry] of otpRateMap) {
    if (now > entry.resetAt) {
      otpRateMap.delete(key);
    }
  }
}

const RequestOtpBody = z.object({ email: z.string().email() });
const VerifyOtpBody = z.object({ email: z.string().email(), otp: z.string().length(6) });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });

/**
 * POST /api/auth/request-otp
 * Body: { email }
 */
export async function requestOtpHandler(c: Context): Promise<Response> {
  const parsed = RequestOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Valid email is required' }, 400);
  }

  const { email } = parsed.data;

  if (isOtpRateLimited(email)) {
    return c.json({ code: 'RATE_LIMITED', message: 'Too many requests. Please wait before trying again.' }, 429);
  }

  const otp = generateOtp(email);

  try {
    await sendOtpEmail(email, otp);
  } catch (err) {
    log.error({ err, email: redactEmail(email) }, 'Failed to send OTP email');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to send verification code' }, 500);
  }

  return c.json({ message: 'Verification code sent' }, 200);
}

/**
 * POST /api/auth/verify-otp
 * Body: { email, otp }
 * Returns { accessToken, refreshToken } for all clients.
 * Client is responsible for storing the refresh token securely:
 *   - Native (iOS/Android): Capacitor Preferences
 *   - Web: sessionStorage
 */
export async function verifyOtpHandler(c: Context): Promise<Response> {
  const parsed = VerifyOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email and 6-digit otp are required' }, 400);
  }

  const { email, otp } = parsed.data;
  const result = verifyOtp(email, otp);

  if (!result.success) {
    const messages: Record<typeof result.reason, string> = {
      not_found: 'No verification code found for this email',
      expired: 'Verification code has expired',
      invalid: 'Incorrect verification code',
      too_many_attempts: 'Too many attempts — please request a new code',
    };
    return c.json({ code: 'UNAUTHORIZED', message: messages[result.reason] }, 401);
  }

  const { accessToken, refreshToken } = issueTokenPair(email);
  return c.json({ accessToken, refreshToken });
}

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 */
export async function refreshHandler(c: Context): Promise<Response> {
  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'UNAUTHORIZED', message: 'refreshToken is required' }, 401);
  }

  const accessToken = refreshAccessToken(parsed.data.refreshToken);
  if (accessToken === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' }, 401);
  }

  return c.json({ accessToken });
}

/**
 * DELETE /api/auth/session
 * Client clears stored tokens on its side.
 */
export function logoutHandler(c: Context): Response {
  return c.json({ message: 'Logged out' });
}

/**
 * Middleware: validates the Authorization: Bearer <token> header.
 * Sets c.set('email', ...) on success.
 */
export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const email = verifyAccessToken(token);
  if (email === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
  }

  c.set('email', email);
  await next();
}
