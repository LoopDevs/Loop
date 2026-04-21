/**
 * Horizon account-balance reader (ADR 015 follow-up).
 *
 * Fetches a Stellar account's asset balances from Horizon
 * `/accounts/{accountId}` and returns the two balances the rest of
 * the backend needs today:
 *
 *   - `xlmStroops`: native XLM balance as BigInt stroops (7 decimals).
 *   - `usdcStroops`: USDC balance as BigInt stroops. Null if the
 *     account has no USDC trustline (the asset won't appear in the
 *     `balances[]` array at all).
 *
 * Consumers:
 *   - Procurement picker (#340) — USDC balance vs. the operator
 *     floor, to decide USDC-vs-XLM CTX payment.
 *   - Admin treasury snapshot (#337) — populate the `assets.USDC`
 *     and `assets.XLM` fields so operators see the yield-earning
 *     pile distinctly from the LOOP-asset liability pile.
 *
 * Why cache: we read this on every procurement tick (every 5s by
 * default) and potentially on every admin treasury page-load. A
 * 30s cache means Horizon sees at most 2 hits/min per account even
 * under aggressive polling, and the staleness is bounded well below
 * the procurement floor's typical magnitude.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon-balances' });

/** Horizon URL resolver — mirrors the pattern in horizon.ts. */
function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

/**
 * Narrowed Horizon account-balances response. We only pin the
 * fields we read; `.passthrough()` isn't worth the surface.
 */
const HorizonBalance = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: z.string(),
});

const HorizonAccountResponse = z.object({
  account_id: z.string(),
  balances: z.array(HorizonBalance),
});

/**
 * Converts a Horizon balance string ("12.3456700") to BigInt stroops.
 * Stellar always returns 7 decimals; we fix a missing decimal point
 * by padding with zeros to keep the parse branch-free.
 *
 * Throws on malformed input — caller's try/catch logs + drops the
 * balance rather than feed a corrupt value into downstream math.
 */
function parseStroops(balance: string): bigint {
  const dot = balance.indexOf('.');
  if (dot === -1) {
    return BigInt(balance) * 10_000_000n;
  }
  const integerPart = balance.slice(0, dot) || '0';
  const decimalPart = balance
    .slice(dot + 1)
    .padEnd(7, '0')
    .slice(0, 7);
  return BigInt(integerPart) * 10_000_000n + BigInt(decimalPart);
}

export interface AccountBalanceSnapshot {
  /** Native XLM balance in stroops. Null only if the account doesn't exist. */
  xlmStroops: bigint | null;
  /** USDC balance in stroops. Null when no trustline to the configured issuer is established. */
  usdcStroops: bigint | null;
  /** Unix ms the snapshot was taken — useful for admin UIs showing freshness. */
  asOfMs: number;
}

interface Cached {
  account: string;
  usdcIssuer: string | null;
  snapshot: AccountBalanceSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: Cached | null = null;

/** Test seam — forgets the cache so the next call re-fetches. */
export function __resetBalanceCacheForTests(): void {
  cached = null;
}

/**
 * Reads `account`'s USDC + XLM balances from Horizon. Caches 30s
 * keyed on `(account, usdcIssuer)` so an operator flipping the
 * issuer env var doesn't serve stale against the wrong asset.
 *
 * `usdcIssuer === null` accepts any USDC-code credit line — MVP
 * leniency matching the watcher's fallback (#168). Production
 * should always pin to Centre's mainnet issuer.
 *
 * Throws on non-2xx / schema drift. A 404 on an unfunded account
 * is treated as `{ xlm: null, usdc: null }` (valid response; the
 * account literally holds nothing).
 */
export async function getAccountBalances(
  account: string,
  usdcIssuer: string | null,
): Promise<AccountBalanceSnapshot> {
  const now = Date.now();
  if (
    cached !== null &&
    cached.account === account &&
    cached.usdcIssuer === usdcIssuer &&
    cached.expiresAt > now
  ) {
    return cached.snapshot;
  }
  const url = `${horizonUrl()}/accounts/${encodeURIComponent(account)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    const snapshot: AccountBalanceSnapshot = {
      xlmStroops: null,
      usdcStroops: null,
      asOfMs: now,
    };
    cached = { account, usdcIssuer, snapshot, expiresAt: now + CACHE_TTL_MS };
    return snapshot;
  }
  if (!res.ok) {
    log.error({ status: res.status, account }, 'Horizon account read failed');
    throw new Error(`Horizon ${res.status} on /accounts/${account}`);
  }
  const raw = await res.json();
  const parsed = HorizonAccountResponse.safeParse(raw);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, account },
      'Horizon account response failed schema validation',
    );
    throw new Error('Horizon schema drift on /accounts');
  }

  let xlmStroops: bigint | null = null;
  let usdcStroops: bigint | null = null;
  for (const b of parsed.data.balances) {
    try {
      if (b.asset_type === 'native') {
        xlmStroops = parseStroops(b.balance);
        continue;
      }
      if (b.asset_code !== 'USDC') continue;
      if (usdcIssuer !== null && b.asset_issuer !== usdcIssuer) continue;
      usdcStroops = parseStroops(b.balance);
    } catch (err) {
      log.warn(
        { err, account, asset: b.asset_code ?? 'native' },
        'Unparseable balance on Horizon account read — skipping entry',
      );
    }
  }

  const snapshot: AccountBalanceSnapshot = {
    xlmStroops,
    usdcStroops,
    asOfMs: now,
  };
  cached = { account, usdcIssuer, snapshot, expiresAt: now + CACHE_TTL_MS };
  return snapshot;
}
