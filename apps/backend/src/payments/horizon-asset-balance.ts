/**
 * Generic LOOP-asset balance reader for an arbitrary Stellar account.
 *
 * Sibling to:
 *   - `horizon-balances.ts` (USDC + XLM, treasury-side)
 *   - `horizon-trustlines.ts` (per-user trustline map for wallet UX)
 *   - `horizon-circulation.ts` (issuer-side total issued)
 *
 * This module answers "how much <CODE>:<ISSUER> does <ACCOUNT> hold?"
 * — used by the interest forward-mint pool reader and any future
 * per-account custody reconciliation. Returns `null` when the
 * account doesn't have a trustline to the asset (= it can't hold
 * any), not `0n`, so callers can distinguish "explicitly zero" from
 * "couldn't possibly hold any."
 *
 * 30s in-process cache keyed on `(account, code, issuer)`. Same
 * cadence as the sibling readers; the asset-drift watcher ticks
 * far less often than that.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon-asset-balance' });

function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

const HorizonBalanceEntry = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: z.string(),
});

const HorizonAccountResponse = z.object({
  account_id: z.string(),
  balances: z.array(HorizonBalanceEntry),
});

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  account: string;
  code: string;
  issuer: string;
  /** `null` when no trustline; `bigint` stroops otherwise. */
  stroops: bigint | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(account: string, code: string, issuer: string): string {
  return `${account}::${code}::${issuer}`;
}

export function __resetAssetBalanceCacheForTests(): void {
  cache.clear();
}

/** `"12.3456700"` → `123456700n`. Matches horizon-trustlines parser. */
function parseStroops(balance: string): bigint {
  const dot = balance.indexOf('.');
  if (dot === -1) return BigInt(balance) * 10_000_000n;
  const integerPart = balance.slice(0, dot) || '0';
  const decimalPart = balance
    .slice(dot + 1)
    .padEnd(7, '0')
    .slice(0, 7);
  return BigInt(integerPart) * 10_000_000n + BigInt(decimalPart);
}

/**
 * Returns `account`'s balance of `code:issuer` in stroops, or `null`
 * when the account has no trustline to that asset (and therefore
 * cannot hold any). Throws on Horizon errors / schema drift; the
 * 404-on-unfunded-account case maps to `null` since an unfunded
 * account literally can't hold any LOOP-asset either.
 */
export async function getAssetBalance(
  account: string,
  code: string,
  issuer: string,
): Promise<bigint | null> {
  const now = Date.now();
  const key = cacheKey(account, code, issuer);
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.stroops;

  const url = `${horizonUrl()}/accounts/${encodeURIComponent(account)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    cache.set(key, { account, code, issuer, stroops: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }
  if (!res.ok) {
    log.error({ status: res.status, account, code, issuer }, 'Horizon /accounts read failed');
    throw new Error(`Horizon ${res.status} on /accounts/${account}`);
  }
  const raw = await res.json();
  const parsed = HorizonAccountResponse.safeParse(raw);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, account, code, issuer },
      'Horizon /accounts response failed schema validation',
    );
    throw new Error('Horizon schema drift on /accounts');
  }

  let stroops: bigint | null = null;
  for (const b of parsed.data.balances) {
    if (b.asset_code === code && b.asset_issuer === issuer) {
      try {
        stroops = parseStroops(b.balance);
      } catch (err) {
        log.error({ err, balance: b.balance, account, code, issuer }, 'Malformed Horizon balance');
        throw err;
      }
      break;
    }
  }
  cache.set(key, { account, code, issuer, stroops, expiresAt: now + CACHE_TTL_MS });
  return stroops;
}
