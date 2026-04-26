/**
 * Bearer-token guard for ops/observability probe endpoints.
 * Pulled out of `app.ts` (A2-1606 / A2-1607).
 *
 * `/metrics` leaks the live route map + circuit-state gauge.
 * `/openapi.json` exposes every admin route + schema. Both are
 * useful for ops tooling but should not be reachable by an
 * arbitrary internet caller.
 *
 * Policy:
 * - When the matching env var is set (`METRICS_BEARER_TOKEN` /
 *   `OPENAPI_BEARER_TOKEN`), the caller must present
 *   `Authorization: Bearer <token>`. Otherwise the route 401s.
 * - When the env var is unset, the route stays open in
 *   `development` / `test` (local tooling + vitest convenience)
 *   and 404s in `production` — closed by default so a probe can't
 *   fingerprint us.
 *
 * Constant-time compare via `crypto.timingSafeEqual` defeats
 * timing-oracle leaks against the token: `timingSafeEqual` throws
 * on length mismatch so we size-check first to avoid leaking
 * "wrong length" vs "wrong byte" via the exception path.
 */
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Context } from 'hono';
import { env } from '../env.js';

/**
 * Returns `true` if the request is allowed past the probe gate.
 *
 * `expected` is the configured shared secret (`undefined` if the
 * env var is unset). When `undefined`, dev/test runs are allowed
 * through and production is blocked. When set, the caller must
 * present a constant-time-equal `Authorization: Bearer …` value.
 */
export function probeGateAllows(c: Context, expected: string | undefined): boolean {
  if (expected === undefined) {
    return env.NODE_ENV !== 'production';
  }
  const header = c.req.header('Authorization');
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return false;
  const presented = match[1]!.trim();
  // Constant-time compare: guard against length leaks + per-byte
  // short-circuit leaks. crypto.timingSafeEqual throws on length
  // mismatch so size first.
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}
