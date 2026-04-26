/**
 * Per-subsystem runtime kill-switch middleware (A2-1907).
 * Returns 503 `SUBSYSTEM_DISABLED` with a Retry-After hint when
 * the matching `LOOP_KILL_<NAME>` env var is set.
 *
 * The `KillSwitch` enum + the `isKilled(name)` predicate live in
 * `../kill-switches.ts` (already its own module). This file just
 * wraps `isKilled` in a Hono middleware factory so a route can
 * mount it inline:
 *
 *     app.post('/api/auth/request-otp', killSwitch('auth'), …)
 *
 * `isKilled` reads `process.env` at call time (not the frozen
 * `env` snapshot) so a Fly-secret flip takes effect on the next
 * request without waiting for the new machine to come up. See
 * `docs/runbooks/` for the operator flow.
 */
import type { Context } from 'hono';
import { isKilled, type KillSwitch } from '../kill-switches.js';

/**
 * Hono middleware factory: returns a middleware that 503s every
 * request when `LOOP_KILL_<subsystem>` is set, otherwise calls
 * through.
 */
export function killSwitch(
  subsystem: KillSwitch,
): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  return async (c, next): Promise<void | Response> => {
    if (isKilled(subsystem)) {
      return c.json(
        {
          code: 'SUBSYSTEM_DISABLED',
          message: `${subsystem} is temporarily disabled — retry shortly`,
        },
        503,
      );
    }
    await next();
  };
}
