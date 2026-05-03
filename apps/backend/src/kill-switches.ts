/**
 * Runtime kill switches (A2-1907).
 *
 * Three subsystems can be flipped off without a redeploy via Fly
 * secrets — useful when a downstream incident (CTX outage, Horizon
 * rate-limit, leaked admin token, etc.) needs the surface gated *now*
 * and the next-deploy cycle is too slow.
 *
 *   - `orders`        → blocks `POST /api/orders` and `POST /api/orders/loop`.
 *   - `auth`          → blocks `POST /api/auth/request-otp`, `verify-otp`,
 *                       `social/google`, `social/apple`. Refresh +
 *                       logout intentionally remain open so existing
 *                       sessions can drain.
 *   - `withdrawals`   → blocks `POST /api/admin/users/:userId/withdrawals`
 *                       and `POST /api/admin/payouts/:id/compensate`.
 *
 * Set via:
 *   `fly secrets set LOOP_KILL_ORDERS=true -a loopfinance-api`
 *
 * Reset by setting `false` (or unsetting).
 *
 * **A4-047:** parsing is now strict. Recognised truthy values
 * (`true`/`1`/`yes`/`on`) engage the kill; recognised falsy
 * values (`false`/`0`/`no`/`off`/`""`) leave it open; anything
 * else (typos like `disabled`, `enable`, `kill`) trigger a loud
 * warning AND fail CLOSED — the kill is treated as engaged. This
 * prefers a visible-but-recoverable false outage (operator sees
 * the subsystem refused requests, fixes the typo) over the
 * previous silent fail-open (operator typo'd while ENGAGING the
 * kill, system kept serving requests because the value didn't
 * match any truthy literal).
 *
 * The check reads `process.env` at request time rather than the
 * frozen `env` snapshot from boot, so a mid-deploy flip takes effect
 * on the next request without waiting for the new machine to come up.
 * (`env.ts` parses + freezes once at boot; that's the right shape for
 * config that doesn't change, but kill switches are explicitly
 * meant to flip live.)
 */
import { logger } from './logger.js';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off', '']);

export type KillSwitch = 'orders' | 'auth' | 'withdrawals';

const ENV_KEY: Record<KillSwitch, string> = {
  orders: 'LOOP_KILL_ORDERS',
  auth: 'LOOP_KILL_AUTH',
  withdrawals: 'LOOP_KILL_WITHDRAWALS',
};

const log = logger.child({ module: 'kill-switches' });

/**
 * Per-(env-key, raw-value) memo so the warning fires once per
 * unique unrecognised value rather than every request. Resets on
 * a value change (operator fixes the typo → next request hits a
 * recognised value → no further warnings).
 */
const warnedFor = new Map<string, string>();

export function isKilled(subsystem: KillSwitch): boolean {
  const envKey = ENV_KEY[subsystem];
  const raw = process.env[envKey];
  if (raw === undefined) return false;
  const lc = raw.trim().toLowerCase();
  if (TRUTHY.has(lc)) return true;
  if (FALSY.has(lc)) return false;
  // A4-047: unrecognised value. Log once per unique value, fail
  // closed. The previous behaviour silently treated typos as
  // falsy (fail-open) — a bad shape for a security-critical kill
  // switch where the operator intent is "stop accepting requests
  // RIGHT NOW."
  const lastSeen = warnedFor.get(envKey);
  if (lastSeen !== lc) {
    log.warn(
      { envKey, value: raw, subsystem },
      'Unrecognised kill-switch value — failing CLOSED (subsystem treated as engaged); set to true/false explicitly',
    );
    warnedFor.set(envKey, lc);
  }
  return true;
}

/** Test seam: drops the warn-once memo so the same unrecognised value warns again. */
export function __resetKillSwitchWarnsForTests(): void {
  warnedFor.clear();
}
