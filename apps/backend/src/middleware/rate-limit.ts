// per-IP per-route rate limiter — A4-001, FT-08, S4-4
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config/index.js';
import { incrementRateLimitHit } from '../metrics.js';
import { currentFleetSizeEstimate } from './fleet-size.js';

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAP_MAX = 10_000;

// A-023, FT-08, A2-1526
export function clientIpFor(c: Context): string {
  if (config.server.trustProxy) {
    // Fly-Client-IP is spoof-proof; X-Forwarded-For is attacker-controlled behind Fly (FT-08)
    const flyClientIp = c.req.header('fly-client-ip')?.trim();
    if (flyClientIp !== undefined && flyClientIp.length > 0) return flyClientIp;
  }
  try {
    const info = getConnInfo(c);
    const address = info.remote.address;
    if (address !== undefined && address.length > 0) return address;
  } catch {
    /* conninfo unavailable — dev server/test harness */
  }
  return 'unknown';
}

export function __resetRateLimitsForTests(): void {
  rateLimitMap.clear();
}

export function sweepExpiredRateLimits(now: number = Date.now()): void {
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}

// A4-001, CF2-10, S4-4
export function rateLimit(
  name: string,
  maxRequests: number,
  windowMs: number,
): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  const mw = async (c: Context, next: () => Promise<void>): Promise<void | Response> => {
    // A2-1605
    if (!config.rateLimit.enabled) {
      await next();
      return;
    }
    const ip = clientIpFor(c);
    const key = `${name}:${ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    // S4-4
    const effectiveMaxRequests = Math.max(1, Math.floor(maxRequests / currentFleetSizeEstimate()));

    if (entry === undefined || now > entry.resetAt) {
      // Evict oldest entry at capacity to prevent OOM
      if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX && entry === undefined) {
        const oldest = rateLimitMap.keys().next().value;
        if (oldest !== undefined) rateLimitMap.delete(oldest);
      }
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > effectiveMaxRequests) {
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header('Retry-After', String(retryAfterSec));
        incrementRateLimitHit();
        return c.json({ code: 'RATE_LIMITED', message: 'Too many requests' }, 429);
      }
    }

    await next();
  };
  // C6
  Object.defineProperty(mw, 'name', { value: `rateLimit(${name})` });
  return mw;
}

// B6
export function globalRateLimit(opts?: {
  maxRequests?: number;
  windowMs?: number;
}): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  const inner = rateLimit('__global__', opts?.maxRequests ?? 600, opts?.windowMs ?? 60_000);
  const mw = async (c: Context, next: () => Promise<void>): Promise<void | Response> => {
    // Exempt /health to avoid 429ing Fly's liveness probe
    if (c.req.path === '/health') {
      await next();
      return;
    }
    return inner(c, next);
  };
  Object.defineProperty(mw, 'name', { value: 'globalRateLimit' });
  return mw;
}
