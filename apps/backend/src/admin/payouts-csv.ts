/**
 * Admin pending-payouts CSV export (ADR 015).
 *
 * `GET /api/admin/payouts.csv` — finance-ready CSV of pending_payouts
 * rows in a time window. Ops downloads this monthly to reconcile
 * on-chain cashback outgoings against the Stellar-side ledger and
 * hand to accounts payable.
 *
 * Window: `?since=<iso>` lower bound on `createdAt`, default 31
 * days ago. Capped at 366 days so an unbounded request can't scan
 * the full table. Row cap 10k — over the cap, the response emits a
 * single `__TRUNCATED__` sentinel row and the handler log-warns
 * with the real rowCount so ops knows to narrow the window.
 *
 * Headers:
 *   Content-Type: text/csv; charset=utf-8
 *   Cache-Control: private, no-store
 *   Content-Disposition: attachment; filename="payouts-<since>.csv"
 *
 * RFC 4180 escaping: field wraps in quotes if it contains `,`, `"`,
 * CR, or LF; embedded `"` doubles to `""`. bigint-as-string for
 * amountStroops + attempts; ISO-8601 for all timestamps.
 */
import type { Context } from 'hono';
import { and, asc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-payouts-csv' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'id',
  'user_id',
  'order_id',
  'asset_code',
  'asset_issuer',
  'to_address',
  'amount_stroops',
  'memo_text',
  'state',
  'tx_hash',
  'last_error',
  'attempts',
  'created_at',
  'submitted_at',
  'confirmed_at',
  'failed_at',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface Row {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: bigint;
  memoText: string;
  state: string;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: Date;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
}

export async function adminPayoutsCsvHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }
  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    const rows = (await db
      .select()
      .from(pendingPayouts)
      .where(and(sql`${pendingPayouts.createdAt} >= ${since}`))
      .orderBy(asc(pendingPayouts.createdAt))
      .limit(ROW_CAP + 1)) as Row[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      lines.push(
        csvRow([
          r.id,
          r.userId,
          r.orderId,
          r.assetCode,
          r.assetIssuer,
          r.toAddress,
          r.amountStroops.toString(),
          r.memoText,
          r.state,
          r.txHash,
          r.lastError,
          r.attempts.toString(),
          r.createdAt.toISOString(),
          r.submittedAt?.toISOString() ?? null,
          r.confirmedAt?.toISOString() ?? null,
          r.failedAt?.toISOString() ?? null,
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin payouts CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `payouts-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin payouts CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
