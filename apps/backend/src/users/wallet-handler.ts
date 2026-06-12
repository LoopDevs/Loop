/**
 * `GET /api/me/wallet` — embedded-wallet balance surface (ADR 030
 * Phase C4).
 *
 * Returns the caller's embedded-wallet address, provisioning state,
 * on-chain LOOP-asset balances (the AUTHORITATIVE balance under
 * ADR 036 — the off-chain mirror is deliberately not exposed here),
 * and the interest APY in basis points for the wallet card's rate
 * chip.
 *
 * Never-500 discipline (ADR 020, but authed): the on-chain read
 * comes from the 30s-cached Horizon trustline reader; when Horizon
 * is unreachable the handler serves the caller's last-known-good
 * balance snapshot (or an empty list when none was ever cached)
 * with `stale: true` instead of failing the wallet card outright.
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { UserWalletBalance, UserWalletResponse } from '@loop/shared';
import { resolveLoopAuthenticatedUser } from '../auth/authenticated-user.js';
import { configuredLoopPayableAssets } from '../credits/payout-asset.js';
import { ONCHAIN_MINT_ELIGIBLE_ASSETS } from '../credits/interest-mint.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';

const log = logger.child({ handler: 'me-wallet' });

/** `123456700n` stroops → `"12.3456700"` (Horizon-style 7-decimal). */
function stroopsToAmount(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/**
 * Last-known-good balances per user — the never-500 fallback when
 * Horizon errors. Bounded by the live-user population of one
 * process; entries are tiny (a handful of code/amount pairs).
 */
const lastKnownBalances = new Map<string, UserWalletBalance[]>();

/** Test seam. */
export function __resetWalletBalanceFallbackForTests(): void {
  lastKnownBalances.clear();
}

export async function getMyWalletHandler(c: Context): Promise<Response> {
  let user;
  try {
    user = await resolveLoopAuthenticatedUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'SERVICE_UNAVAILABLE', message: 'Wallet temporarily unavailable' }, 503);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const assets = configuredLoopPayableAssets();
  // 2026-06-15 cold audit v-wallet P0 follow-up: the mint worker only
  // ever pays ONCHAIN_MINT_ELIGIBLE_ASSETS (GBPLOOP) — advertising the
  // global APY regardless of whether this deployment even has that
  // asset configured is false advertising for every USD/EUR-only
  // deployment (or one where GBPLOOP's issuer isn't set up yet).
  const hasEligibleAsset = assets.some((a) => ONCHAIN_MINT_ELIGIBLE_ASSETS.has(a.code));
  const base = {
    address: user.walletAddress,
    provisioning: user.walletProvisioning,
    // ADR 031 Phase D truthfulness: this surface shows the ON-CHAIN
    // balance, so the rate chip must only advertise an APY the
    // on-chain mint path (`credits/interest-mint.ts`) will actually
    // pay. Legacy off-chain accrual (mirror-only) does not move the
    // wallet balance and must not be advertised here; 0 = no rate chip.
    interestApyBps:
      env.LOOP_INTEREST_ONCHAIN_ENABLED && hasEligibleAsset ? env.INTEREST_APY_BASIS_POINTS : 0,
  };

  // No on-chain account to read until the wallet exists.
  if (user.walletAddress === null) {
    return c.json<UserWalletResponse>({ ...base, balances: [], stale: false });
  }
  try {
    const snapshot = await getAccountTrustlines(user.walletAddress);
    const balances: UserWalletBalance[] = [];
    for (const asset of assets) {
      const line = snapshot.trustlines.get(`${asset.code}::${asset.issuer}`);
      if (line === undefined) continue;
      balances.push({ assetCode: asset.code, balance: stroopsToAmount(line.balanceStroops) });
    }
    lastKnownBalances.set(user.id, balances);
    return c.json<UserWalletResponse>({ ...base, balances, stale: false });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId: user.id },
      'Horizon unavailable for wallet balances — serving last-known-good',
    );
    const cached = lastKnownBalances.get(user.id) ?? [];
    return c.json<UserWalletResponse>({ ...base, balances: cached, stale: true });
  }
}
