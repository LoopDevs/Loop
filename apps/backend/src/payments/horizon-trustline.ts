/**
 * Horizon trustline checker (ADR 015 follow-up).
 *
 * Given a Stellar account + LOOP asset (code + issuer), asks Horizon
 * `/accounts/{accountId}` whether the trustline exists. Used by
 * `GET /api/users/me/trustline-status` so the settings/wallet page
 * can switch the amber "Add a trustline" prompt off once the user
 * has actually added it in their wallet.
 *
 * Isolated from `horizon-balances.ts` so the trustline path can
 * grow its own cache strategy + test harness without perturbing the
 * hot-path procurement + admin-treasury reads.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon-trustline' });

function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

const HorizonBalance = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
});

const HorizonAccountResponse = z.object({
  balances: z.array(HorizonBalance),
});

/**
 * Display / routing states for the /settings/wallet trustline card.
 * - `active`          — trustline is established; hide guidance entirely.
 * - `missing`         — account exists but no matching trustline; show amber.
 * - `account_not_found` — wallet pubkey has no on-chain account. Still an
 *   amber prompt, but the copy can point the user to funding first.
 * - `unavailable`     — Horizon failed; keep the amber prompt on as a safe
 *   default. Distinguishing this in the UI lets the client avoid lying
 *   that the trustline is "missing" when we simply don't know.
 */
export type TrustlineStatus = 'active' | 'missing' | 'account_not_found' | 'unavailable';

export interface TrustlineCheckResult {
  status: TrustlineStatus;
  /** Unix ms this check completed — useful for cache-freshness hints. */
  asOfMs: number;
}

const CACHE_TTL_MS = 30_000;

interface Cached {
  account: string;
  assetCode: string;
  assetIssuer: string;
  result: TrustlineCheckResult;
  expiresAt: number;
}

let cached: Cached | null = null;

/** Test seam. */
export function __resetTrustlineCacheForTests(): void {
  cached = null;
}

/**
 * Returns whether `account` has an established trustline to the
 * `(assetCode, assetIssuer)` LOOP asset. 30-second TTL cache keyed
 * on the whole tuple — the same user hitting the settings page in
 * quick succession (e.g. after clicking Copy) reads from cache.
 *
 * Never throws. `unavailable` is the fallthrough for network /
 * schema-drift failures so the caller can render a "we couldn't
 * check" state rather than a false positive.
 */
export async function checkTrustline(
  account: string,
  assetCode: string,
  assetIssuer: string,
): Promise<TrustlineCheckResult> {
  const now = Date.now();
  if (
    cached !== null &&
    cached.account === account &&
    cached.assetCode === assetCode &&
    cached.assetIssuer === assetIssuer &&
    cached.expiresAt > now
  ) {
    return cached.result;
  }

  let result: TrustlineCheckResult;
  try {
    const url = `${horizonUrl()}/accounts/${encodeURIComponent(account)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/hal+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      result = { status: 'account_not_found', asOfMs: now };
    } else if (!res.ok) {
      log.warn({ status: res.status, account }, 'Horizon trustline read non-OK');
      result = { status: 'unavailable', asOfMs: now };
    } else {
      const raw = await res.json();
      const parsed = HorizonAccountResponse.safeParse(raw);
      if (!parsed.success) {
        log.warn({ issues: parsed.error.issues, account }, 'Horizon trustline schema drift');
        result = { status: 'unavailable', asOfMs: now };
      } else {
        const match = parsed.data.balances.some(
          (b) =>
            b.asset_type !== 'native' &&
            b.asset_code === assetCode &&
            b.asset_issuer === assetIssuer,
        );
        result = { status: match ? 'active' : 'missing', asOfMs: now };
      }
    }
  } catch (err) {
    log.warn({ err, account, assetCode }, 'Horizon trustline fetch errored');
    result = { status: 'unavailable', asOfMs: now };
  }

  cached = { account, assetCode, assetIssuer, result, expiresAt: now + CACHE_TTL_MS };
  return result;
}
