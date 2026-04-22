/**
 * Admin payout-backlog view (ADR 015).
 *
 * `GET /api/admin/payouts` — paginated list of `pending_payouts`
 * rows for the admin UI's "payouts" page. Filter on `?state=failed`
 * to drill into stuck rows, pass `?before=<iso>` to page older.
 *
 * The treasury snapshot (#349) exposes per-state counts for the
 * at-a-glance card; this endpoint is what the operator clicks
 * through to when they want to see which orders / which users are
 * in each bucket.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { PAYOUT_STATES, pendingPayouts } from '../db/schema.js';
import { listPayoutsForAdmin, resetPayoutToPending } from '../credits/pending-payouts.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-payouts' });

export interface AdminPayoutView {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: string;
  memoText: string;
  state: string;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

interface PayoutRow {
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

function toView(row: PayoutRow): AdminPayoutView {
  return {
    id: row.id,
    userId: row.userId,
    orderId: row.orderId,
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    toAddress: row.toAddress,
    amountStroops: row.amountStroops.toString(),
    memoText: row.memoText,
    state: row.state,
    txHash: row.txHash,
    lastError: row.lastError,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

export async function adminListPayoutsHandler(c: Context): Promise<Response> {
  const stateParam = c.req.query('state');
  if (stateParam !== undefined && !(PAYOUT_STATES as ReadonlyArray<string>).includes(stateParam)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `state must be one of: ${PAYOUT_STATES.join(', ')}`,
      },
      400,
    );
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 20 : parsedLimit, 1), 100);

  const beforeRaw = c.req.query('before');
  let before: Date | undefined;
  if (beforeRaw !== undefined && beforeRaw.length > 0) {
    const d = new Date(beforeRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
        400,
      );
    }
    before = d;
  }

  const rows = await listPayoutsForAdmin({
    ...(stateParam !== undefined ? { state: stateParam } : {}),
    ...(before !== undefined ? { before } : {}),
    limit,
  });
  return c.json({ payouts: rows.map((r) => toView(r as PayoutRow)) });
}

export interface AdminPayoutsSummaryResponse {
  /** Per-state row counts — every state present in PAYOUT_STATES, zero-filled. */
  counts: Record<(typeof PAYOUT_STATES)[number], number>;
  /**
   * ISO-8601 timestamp of the oldest `pending` row still waiting for
   * the submit worker. Null when the pending queue is empty — the
   * normal steady state. Drives the "oldest queued payout is Nm old"
   * badge on the admin dashboard.
   */
  oldestPendingAt: string | null;
  /**
   * Same for `submitted` — rows awaiting Horizon confirmation. Staleness
   * here points at a stuck transaction or a stalled confirm worker.
   */
  oldestSubmittedAt: string | null;
  /** Total stroops currently queued as `pending` across all LoopAssets. */
  pendingStroops: string;
}

interface PayoutSummaryRow extends Record<string, unknown> {
  state: string;
  n: string | number;
  oldest: string | Date | null;
  totalStroops: string | null;
}

/**
 * GET /api/admin/payouts/summary
 *
 * One GROUP BY gives ops the chip strip at the top of /admin/payouts:
 * per-state counts, oldest queued-at for pending + submitted, and the
 * total stroops currently queued (so the treasury card and the payouts
 * card agree on outstanding exposure without two round-trips).
 */
export async function adminPayoutsSummaryHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<PayoutSummaryRow>(sql`
      SELECT
        ${pendingPayouts.state} AS state,
        COUNT(*)::bigint AS n,
        MIN(${pendingPayouts.createdAt}) AS oldest,
        COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::bigint AS "totalStroops"
      FROM ${pendingPayouts}
      GROUP BY ${pendingPayouts.state}
    `);
    const rows: PayoutSummaryRow[] = Array.isArray(result)
      ? (result as PayoutSummaryRow[])
      : ((result as { rows?: PayoutSummaryRow[] }).rows ?? []);

    const counts = Object.fromEntries(PAYOUT_STATES.map((s) => [s, 0])) as Record<
      (typeof PAYOUT_STATES)[number],
      number
    >;
    let oldestPendingAt: string | null = null;
    let oldestSubmittedAt: string | null = null;
    let pendingStroops = 0n;

    for (const row of rows) {
      const state = row.state as (typeof PAYOUT_STATES)[number];
      if ((PAYOUT_STATES as ReadonlyArray<string>).includes(state)) {
        counts[state] = Number(row.n);
      }
      if (state === 'pending') {
        pendingStroops = BigInt(row.totalStroops ?? '0');
        if (row.oldest !== null && row.oldest !== undefined) {
          oldestPendingAt =
            row.oldest instanceof Date
              ? row.oldest.toISOString()
              : new Date(row.oldest).toISOString();
        }
      }
      if (state === 'submitted') {
        if (row.oldest !== null && row.oldest !== undefined) {
          oldestSubmittedAt =
            row.oldest instanceof Date
              ? row.oldest.toISOString()
              : new Date(row.oldest).toISOString();
        }
      }
    }

    return c.json<AdminPayoutsSummaryResponse>({
      counts,
      oldestPendingAt,
      oldestSubmittedAt,
      pendingStroops: pendingStroops.toString(),
    });
  } catch (err) {
    log.error({ err }, 'Admin payouts summary failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load payouts summary' }, 500);
  }
}

/**
 * POST /api/admin/payouts/:id/retry — flip a `failed` row back to
 * `pending` so the submit worker picks it up on the next tick. Admin
 * use only: unbounded-retry from the worker itself would mask real
 * issues, so retry is a manual ops action with an audit trail via
 * the admin user context (set by `requireAdmin`).
 *
 * Returns the updated row on success, 404 when the id doesn't match
 * a `failed` row (either it doesn't exist or it's in a non-failed
 * state — admin UI should refresh the list).
 */
export async function adminRetryPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  try {
    const row = await resetPayoutToPending(id);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found or not in failed state' }, 404);
    }
    log.info({ payoutId: id }, 'Payout reset to pending by admin retry');
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin retry failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to retry payout' }, 500);
  }
}
