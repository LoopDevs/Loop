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
 * Reset by setting `false` (or unsetting). Boolean parsing tolerates
 * the usual operator typos — see `envBoolean` in `env.ts`.
 *
 * The check reads `process.env` at request time rather than the
 * frozen `env` snapshot from boot, so a mid-deploy flip takes effect
 * on the next request without waiting for the new machine to come up.
 * (`env.ts` parses + freezes once at boot; that's the right shape for
 * config that doesn't change, but kill switches are explicitly
 * meant to flip live.)
 */
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export type KillSwitch = 'orders' | 'auth' | 'withdrawals';

const ENV_KEY: Record<KillSwitch, string> = {
  orders: 'LOOP_KILL_ORDERS',
  auth: 'LOOP_KILL_AUTH',
  withdrawals: 'LOOP_KILL_WITHDRAWALS',
};

export function isKilled(subsystem: KillSwitch): boolean {
  const raw = process.env[ENV_KEY[subsystem]];
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
