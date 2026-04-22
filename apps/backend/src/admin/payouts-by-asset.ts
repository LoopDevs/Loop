/**
 * Admin payouts-by-asset breakdown (ADR 015 / 016).
 *
 * `GET /api/admin/payouts-by-asset` — crosses `pending_payouts` by
 * `(asset_code, state)` so ops can see, per LOOP stablecoin, how
 * much is in each lifecycle state (pending / submitted / confirmed
 * / failed). The treasury snapshot at `/api/admin/treasury`
 * surfaces per-state counts and per-asset outstanding liability;
 * this endpoint is the crossed view that answers "I see 3 failed
 * payouts — which assets are affected?".
 *
 * All amounts in stroops (bigint-as-string), matching
 * `pending_payouts.amount_stroops`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts-by-asset' });

const PAYOUT_STATES = ['pending', 'submitted', 'confirmed', 'failed'] as const;
type PayoutState = (typeof PAYOUT_STATES)[number];

export interface PerStateBreakdown {
  /** Count of rows in this state. */
  count: number;
  /** Sum of amount_stroops for rows in this state; bigint-as-string. */
  stroops: string;
}

export type PayoutsByAssetRow = {
  assetCode: string;
} & Record<PayoutState, PerStateBreakdown>;

export interface PayoutsByAssetResponse {
  rows: PayoutsByAssetRow[];
}

interface AggRow {
  asset_code: string;
  state: string;
  count: string | number;
  stroops: string | number | bigint;
}

function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 10);
}
function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

function zeroPerState(): Record<PayoutState, PerStateBreakdown> {
  return {
    pending: { count: 0, stroops: '0' },
    submitted: { count: 0, stroops: '0' },
    confirmed: { count: 0, stroops: '0' },
    failed: { count: 0, stroops: '0' },
  };
}

export async function adminPayoutsByAssetHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute(sql`
      SELECT
        ${pendingPayouts.assetCode} AS asset_code,
        ${pendingPayouts.state}      AS state,
        COUNT(*)::bigint             AS count,
        COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::bigint AS stroops
      FROM ${pendingPayouts}
      GROUP BY ${pendingPayouts.assetCode}, ${pendingPayouts.state}
      ORDER BY ${pendingPayouts.assetCode} ASC
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const byAsset: Record<string, Record<PayoutState, PerStateBreakdown>> = {};
    for (const r of rows) {
      if (!(PAYOUT_STATES as ReadonlyArray<string>).includes(r.state)) continue;
      const bucket = byAsset[r.asset_code] ?? zeroPerState();
      bucket[r.state as PayoutState] = {
        count: toNumber(r.count),
        stroops: toStringBigint(r.stroops),
      };
      byAsset[r.asset_code] = bucket;
    }

    const response: PayoutsByAssetResponse = {
      rows: Object.entries(byAsset)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([assetCode, states]) => ({ assetCode, ...states })),
    };
    return c.json(response);
  } catch (err) {
    log.error({ err }, 'Admin payouts-by-asset query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute payouts by asset' }, 500);
  }
}
