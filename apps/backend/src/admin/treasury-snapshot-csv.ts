/**
 * Admin treasury snapshot CSV (ADR 009/015/018).
 *
 * `GET /api/admin/treasury.csv` — point-in-time flat dump of the
 * same aggregate the JSON `/api/admin/treasury` serves, shaped for
 * compliance / SOC-2 / audit evidence. Diff-friendly **long
 * format**: one row per (metric, key, value) tuple so successive
 * snapshots line up in diff tooling and auditors can eyeball which
 * field moved between two evidence runs.
 *
 * Columns: `metric,key,value`
 *
 * Metric vocabulary:
 *   - snapshot_taken_at   key=''            value=ISO-8601
 *   - outstanding         key=CURRENCY      value=minor units string
 *   - ledger_total        key=CURRENCY:TYPE value=minor units string
 *   - liability           key=ASSET_CODE    value=minor units string
 *   - liability_issuer    key=ASSET_CODE    value=pubkey or ''
 *   - asset_stroops       key=ASSET_CODE    value=stroops or ''
 *   - payout_state        key=STATE         value=integer count
 *   - operator            key=OPERATOR_ID   value=STATE
 *   - operator_pool_size  key=''            value=integer
 *
 * ADR 018 conventions inherited: 10/min Tier-3 rate, Cache-Control
 * private/no-store, stable filename, error envelopes. Reuses the
 * existing treasuryHandler JSON shape — a lightweight in-memory
 * reshape, no new DB queries.
 */
import type { Context } from 'hono';
import { treasuryHandler } from './treasury.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-treasury-snapshot-csv' });

const HEADERS = ['metric', 'key', 'value'] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface SnapshotLike {
  outstanding: Record<string, string>;
  totals: Record<string, Record<string, string>>;
  liabilities: Record<string, { outstandingMinor: string; issuer: string | null }>;
  assets: Record<string, { stroops: string | null }>;
  payouts: Record<string, string>;
  operatorPool: {
    size: number;
    operators: Array<{ id: string; state: string }>;
  };
}

export async function adminTreasurySnapshotCsvHandler(c: Context): Promise<Response> {
  try {
    // Delegate to the JSON handler; re-parse its body. This keeps
    // both surfaces on exactly the same aggregate — if a future
    // slice adds a new metric to the snapshot, this CSV picks it
    // up as long as `buildLine` knows the shape.
    const jsonRes = await treasuryHandler(c);
    if (jsonRes.status !== 200) {
      // Pass through upstream failure status; avoid forging success.
      return jsonRes;
    }
    const snapshot = (await jsonRes.json()) as SnapshotLike;

    const lines: string[] = [HEADERS.join(',')];
    lines.push(csvRow(['snapshot_taken_at', '', new Date().toISOString()]));

    // outstanding[currency]
    for (const [currency, value] of Object.entries(snapshot.outstanding).sort()) {
      lines.push(csvRow(['outstanding', currency, value]));
    }

    // totals[currency][type]
    for (const [currency, byType] of Object.entries(snapshot.totals).sort()) {
      for (const [type, value] of Object.entries(byType).sort()) {
        lines.push(csvRow(['ledger_total', `${currency}:${type}`, value]));
      }
    }

    // liabilities[assetCode] → split into value + issuer rows
    for (const [code, row] of Object.entries(snapshot.liabilities).sort()) {
      lines.push(csvRow(['liability', code, row.outstandingMinor]));
      lines.push(csvRow(['liability_issuer', code, row.issuer ?? '']));
    }

    // assets[code].stroops
    for (const [code, holding] of Object.entries(snapshot.assets).sort()) {
      lines.push(csvRow(['asset_stroops', code, holding.stroops ?? '']));
    }

    // payouts[state]
    for (const [state, count] of Object.entries(snapshot.payouts).sort()) {
      lines.push(csvRow(['payout_state', state, count]));
    }

    // operator-pool
    lines.push(csvRow(['operator_pool_size', '', String(snapshot.operatorPool.size)]));
    const operators = [...snapshot.operatorPool.operators].sort((a, b) => a.id.localeCompare(b.id));
    for (const op of operators) {
      lines.push(csvRow(['operator', op.id, op.state]));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `treasury-snapshot-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin treasury snapshot CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
