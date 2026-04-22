/**
 * Admin payouts-by-asset breakdown (ADR 015 / 016 / 019 Tier 1).
 *
 * `GET /api/admin/payouts/by-asset` — per-asset × per-state counts +
 * stroops totals. Complements `/api/admin/payouts/summary` (#426)
 * which aggregates across assets; this one pivots on `asset_code`
 * so ops can see "how much USDLOOP is queued, how much GBPLOOP,
 * how much EURLOOP?" at a glance.
 *
 * Single GROUP BY over `(asset_code, state)`. Response is zero-filled
 * across every (code, state) pair that ever appeared so the UI
 * renders a stable layout — dropping to zero shows up as an explicit
 * 0 rather than a missing cell.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { PAYOUT_STATES, pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts-by-asset' });

export interface PayoutsPerState {
  count: number;
  stroops: string;
}

export type PayoutState = (typeof PAYOUT_STATES)[number];

export interface AdminPayoutsByAssetResponse {
  /**
   * Outer key is the asset code (USDLOOP / GBPLOOP / EURLOOP or any
   * other code we see in `pending_payouts`). Inner map is a
   * zero-filled state → totals record.
   */
  byAsset: Record<string, Record<PayoutState, PayoutsPerState>>;
}

interface Row extends Record<string, unknown> {
  assetCode: string;
  state: string;
  count: string | number;
  stroops: string | null;
}

function zeroPerState(): Record<PayoutState, PayoutsPerState> {
  return Object.fromEntries(PAYOUT_STATES.map((s) => [s, { count: 0, stroops: '0' }])) as Record<
    PayoutState,
    PayoutsPerState
  >;
}

export async function adminPayoutsByAssetHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<Row>(sql`
      SELECT
        ${pendingPayouts.assetCode} AS "assetCode",
        ${pendingPayouts.state} AS state,
        COUNT(*)::bigint AS count,
        COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::bigint AS stroops
      FROM ${pendingPayouts}
      GROUP BY ${pendingPayouts.assetCode}, ${pendingPayouts.state}
      ORDER BY ${pendingPayouts.assetCode} ASC
    `);
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    const byAsset: AdminPayoutsByAssetResponse['byAsset'] = {};
    for (const row of rows) {
      const state = row.state as PayoutState;
      if (!(PAYOUT_STATES as ReadonlyArray<string>).includes(state)) continue;
      const bucket = byAsset[row.assetCode] ?? zeroPerState();
      bucket[state] = {
        count: Number(row.count),
        stroops: (row.stroops ?? '0').toString(),
      };
      byAsset[row.assetCode] = bucket;
    }

    return c.json<AdminPayoutsByAssetResponse>({ byAsset });
  } catch (err) {
    log.error({ err }, 'Admin payouts-by-asset failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load payouts by asset' }, 500);
  }
}
