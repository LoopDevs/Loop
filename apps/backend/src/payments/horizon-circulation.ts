/**
 * Horizon LOOP-asset circulation reader (ADR 015).
 *
 * Answers: "how many <ASSET_CODE> stroops are currently in
 * circulation under <issuer>?". Circulation = total issued, net
 * of what the issuer itself holds — i.e. what's out in the wild
 * backed by Loop's fiat reserves.
 *
 * Used by the admin treasury drift-detection surface — compare
 * this (on-chain issued) against `user_credits` outstanding
 * liability (off-chain ledger). A non-zero drift that isn't
 * explained by in-flight payouts is the "something broke"
 * signal for a stablecoin operator.
 *
 * Reads Horizon `/assets?asset_code=X&asset_issuer=Y`. The
 * endpoint returns a paginated list; we pin to a single
 * (code, issuer) so the `_embedded.records` array has at most
 * one row. `.amount` is the base-10 issued total with 7-decimal
 * precision; we convert to stroops (BigInt) to match the rest
 * of the stablecoin-side arithmetic.
 *
 * 30s in-memory cache keyed on `(code, issuer)` — same cadence
 * as the treasury snapshot + operator balance reads, so a single
 * admin page-load hits Horizon at most once per asset per 30s.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'horizon-circulation' });

/** Horizon URL — see horizon-balances.ts for the read-at-call-time rationale. */
function horizonUrl(): string {
  const v = process.env['LOOP_STELLAR_HORIZON_URL'];
  if (typeof v === 'string' && v.length > 0) return v;
  return 'https://horizon.stellar.org';
}

/**
 * Horizon `/assets` record shape — pinned to the subset we read.
 * `.amount` is a decimal string like `"1234.5670000"`. Anything
 * beyond 7 decimal places would violate the Stellar asset
 * precision contract; rather than silently truncating, we reject
 * at schema parse so a future Horizon change surfaces as a 500
 * with a clear log line rather than a quietly-wrong number.
 */
const AssetRecord = z.object({
  asset_code: z.string(),
  asset_issuer: z.string(),
  amount: z.string().regex(/^-?\d+(\.\d{1,7})?$/),
});

const AssetsListResponse = z.object({
  _embedded: z.object({
    records: z.array(AssetRecord),
  }),
});

export interface AssetCirculationSnapshot {
  assetCode: string;
  issuer: string;
  /** Issued circulation in stroops (7-decimal BigInt). 0n when Horizon returns no record. */
  stroops: bigint;
  /** Unix ms the snapshot was read. */
  asOfMs: number;
}

interface Cached {
  key: string;
  snapshot: AssetCirculationSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
let cached: Cached | null = null;

function cacheKey(code: string, issuer: string): string {
  return `${code}::${issuer}`;
}

/** Test seam — forgets the cache so the next call re-fetches. */
export function __resetCirculationCacheForTests(): void {
  cached = null;
}

/** `"1234.567"` → `12345670000n` (stroops). Rejects malformed input. */
export function amountToStroops(amount: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (match === null) {
    throw new Error(`Malformed Horizon amount: ${amount}`);
  }
  const [, sign, whole, fractionRaw] = match;
  const fraction = (fractionRaw ?? '').padEnd(7, '0');
  const unsigned = BigInt(`${whole ?? '0'}${fraction}`);
  return sign === '-' ? -unsigned : unsigned;
}

/**
 * Reads issued circulation for one LOOP asset from Horizon. Returns
 * `stroops: 0n` when the asset has never been issued (empty records
 * array) — distinct from a fetch failure, which throws.
 *
 * 30s cache hit returns immediately; cache miss or expiry triggers
 * a fresh fetch. Schema-drift / non-2xx surface as thrown errors so
 * the admin handler can convert them to a 503 while keeping the
 * ledger-side liability authoritative.
 */
export async function getLoopAssetCirculation(
  assetCode: string,
  issuer: string,
): Promise<AssetCirculationSnapshot> {
  const now = Date.now();
  const key = cacheKey(assetCode, issuer);
  if (cached !== null && cached.key === key && cached.expiresAt > now) {
    return cached.snapshot;
  }
  const url = new URL(`${horizonUrl()}/assets`);
  url.searchParams.set('asset_code', assetCode);
  url.searchParams.set('asset_issuer', issuer);
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/hal+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    log.error({ status: res.status, assetCode, issuer }, 'Horizon /assets read failed');
    throw new Error(`Horizon ${res.status} on /assets`);
  }
  const raw = await res.json();
  const parsed = AssetsListResponse.safeParse(raw);
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, assetCode, issuer },
      'Horizon /assets response failed schema validation',
    );
    throw new Error('Horizon schema drift on /assets');
  }

  const record = parsed.data._embedded.records[0];
  const stroops = record === undefined ? 0n : amountToStroops(record.amount);
  const snapshot: AssetCirculationSnapshot = {
    assetCode,
    issuer,
    stroops,
    asOfMs: now,
  };
  cached = { key, snapshot, expiresAt: now + CACHE_TTL_MS };
  return snapshot;
}
