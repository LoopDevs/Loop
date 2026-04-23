/**
 * Horizon trustline reader (ADR 015).
 *
 * Fetches `/accounts/{accountId}` and returns the map of asset
 * trustlines the account has established, keyed as `${code}::${issuer}`.
 * Lets the user-facing wallet page warn "you've linked your Stellar
 * address but you're missing the USDLOOP trustline — your next payout
 * will fail with `op_no_trust`" before the payout worker finds out.
 *
 * Distinct from `horizon-balances.ts` which returns narrow
 * XLM + USDC balances for the treasury side. This reader is scoped
 * to a user's own address and speaks trustlines, not balances.
 *
 * Cache: 30s per address. A user polling their own wallet page
 * (10s refetch interval on the eventual UI) hits Horizon at most
 * 2x/min — well under Horizon's default limits.
 *
 * Errors:
 *   - 404 from Horizon (account not activated / typo) → returns an
 *     empty-map snapshot with `accountExists: false`. Callers treat
 *     this as "no trustlines, link something valid first".
 *   - 5xx / schema drift → throws. Handlers convert to 503.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon-trustlines' });

function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

const HorizonBalance = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: z.string(),
  limit: z.string().optional(),
});

const HorizonAccountResponse = z.object({
  account_id: z.string(),
  balances: z.array(HorizonBalance),
});

export interface TrustlineEntry {
  code: string;
  issuer: string;
  /** Trustline limit in stroops. 0n when Horizon returned no limit (shouldn't happen for credit assets). */
  limitStroops: bigint;
  /** Current balance in stroops. */
  balanceStroops: bigint;
}

export interface AccountTrustlinesSnapshot {
  account: string;
  accountExists: boolean;
  /** Key: `${code}::${issuer}`. */
  trustlines: Map<string, TrustlineEntry>;
  asOfMs: number;
}

interface Cached {
  account: string;
  snapshot: AccountTrustlinesSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, Cached>();

export function __resetTrustlineCacheForTests(): void {
  cache.clear();
}

/** `"12.3456700"` → `123456700n` stroops (7-decimal). Defensive on missing dot. */
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

export async function getAccountTrustlines(account: string): Promise<AccountTrustlinesSnapshot> {
  const now = Date.now();
  const hit = cache.get(account);
  if (hit !== undefined && hit.expiresAt > now) {
    return hit.snapshot;
  }

  const url = `${horizonUrl()}/accounts/${encodeURIComponent(account)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    const snapshot: AccountTrustlinesSnapshot = {
      account,
      accountExists: false,
      trustlines: new Map(),
      asOfMs: now,
    };
    cache.set(account, { account, snapshot, expiresAt: now + CACHE_TTL_MS });
    return snapshot;
  }
  if (!res.ok) {
    log.error({ status: res.status, account }, 'Horizon /accounts read failed');
    throw new Error(`Horizon ${res.status} on /accounts/${account}`);
  }

  const raw = await res.json();
  const parsed = HorizonAccountResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, account }, 'Horizon /accounts schema drift');
    throw new Error('Horizon schema drift on /accounts');
  }

  const trustlines = new Map<string, TrustlineEntry>();
  for (const b of parsed.data.balances) {
    // Skip the `native` (XLM) row — it's not a trustline, just the
    // account reserve. Our trustline map is explicitly for credit
    // assets the user has opted into.
    if (b.asset_code === undefined || b.asset_issuer === undefined) continue;
    const code = b.asset_code;
    const issuer = b.asset_issuer;
    const key = `${code}::${issuer}`;
    let balanceStroops: bigint;
    let limitStroops: bigint;
    try {
      balanceStroops = parseStroops(b.balance);
      limitStroops = b.limit !== undefined ? parseStroops(b.limit) : 0n;
    } catch (err) {
      log.warn({ err, account, code, issuer }, 'Skipping unparseable trustline');
      continue;
    }
    trustlines.set(key, { code, issuer, balanceStroops, limitStroops });
  }

  const snapshot: AccountTrustlinesSnapshot = {
    account,
    accountExists: true,
    trustlines,
    asOfMs: now,
  };
  cache.set(account, { account, snapshot, expiresAt: now + CACHE_TTL_MS });
  return snapshot;
}
