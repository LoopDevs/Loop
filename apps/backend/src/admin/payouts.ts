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
import { z } from 'zod';
import { PAYOUT_STATES } from '../db/schema.js';
import {
  getPayoutByOrderId,
  getPayoutForAdmin,
  listPayoutsForAdmin,
  resetPayoutToPending,
} from '../credits/pending-payouts.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  validateIdempotencyKey,
} from './idempotency.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const userIdParam = c.req.query('userId');
  if (userIdParam !== undefined && !UUID_RE.test(userIdParam)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  const rows = await listPayoutsForAdmin({
    ...(stateParam !== undefined ? { state: stateParam } : {}),
    ...(userIdParam !== undefined ? { userId: userIdParam } : {}),
    ...(before !== undefined ? { before } : {}),
    limit,
  });
  return c.json({ payouts: rows.map((r) => toView(r as PayoutRow)) });
}

/**
 * GET /api/admin/payouts/:id — single-row drill-down. The list
 * endpoint at `/api/admin/payouts` truncates the admin UI at 100 rows
 * and has no per-row permalink; this endpoint is what the admin table
 * links each row to so ops can deep-link a specific stuck payout into
 * a ticket / incident note without hunting for the row in the list.
 *
 * 400 on missing / malformed id (must be a uuid — the column is a uuid
 * pk, so anything else is guaranteed to miss). 404 when the row
 * doesn't exist. 500 on repo throw.
 */
export async function adminGetPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (!UUID_RE.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutForAdmin(id);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin payout detail failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
  }
}

/**
 * GET /api/admin/orders/:orderId/payout — given an order id, return
 * the single pending_payouts row associated with it (UNIQUE on
 * order_id). Ops hits this when a user raises a support ticket
 * quoting an order id — saves them fishing through the payout list
 * for the matching row.
 *
 * 400 on missing / non-uuid order id, 404 when the order has no
 * payout row yet (common — the payout builder only runs once
 * cashback is due). 500 on repo throw.
 */
export async function adminPayoutByOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('orderId');
  if (orderId === undefined || orderId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId is required' }, 400);
  }
  if (!UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'orderId must be a uuid' }, 400);
  }
  try {
    const row = await getPayoutByOrderId(orderId);
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'No payout for this order' }, 404);
    }
    return c.json<AdminPayoutView>(toView(row as PayoutRow));
  } catch (err) {
    log.error({ err, orderId }, 'Admin payout-by-order lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch payout' }, 500);
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
const RetryBodySchema = z.object({
  reason: z.string().min(2).max(500),
});

/**
 * ADR 017 compliant. Payout retry is an admin write — every invariant
 * applies: actor from `requireAdmin`, Idempotency-Key header required,
 * `reason` body (2..500 chars), snapshot replay on repeat, Discord
 * audit fanout AFTER commit. Response envelope is `{ result, audit }`
 * to match the credit-adjustment write so the admin UI renders both
 * the same way.
 */
export async function adminRetryPayoutHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (id === undefined || !UUID_RE.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be a uuid' }, 400);
  }

  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }

  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = RetryBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  const endpointPath = `/api/admin/payouts/${id}/retry`;

  // Replay path: snapshot hit -> return stored response + audit-fanout
  // marked replayed so Discord still shows the second click.
  const prior = await lookupIdempotencyKey({
    adminUserId: actor.id,
    key: idempotencyKey,
  });
  if (prior !== null) {
    const priorResult = (prior.body as { result?: AdminPayoutView }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      endpoint: `POST ${endpointPath}`,
      ...(priorResult?.userId !== undefined ? { targetUserId: priorResult.userId } : {}),
      reason: parsed.data.reason,
      idempotencyKey,
      replayed: true,
    });
    return c.json(prior.body, prior.status as 200 | 400 | 404 | 500);
  }

  // Fresh retry.
  let row;
  try {
    row = await resetPayoutToPending(id);
  } catch (err) {
    log.error({ err, payoutId: id }, 'Admin retry failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to retry payout' }, 500);
  }
  if (row === null) {
    // 404 response isn't snapshot-stored — the payout didn't
    // transition, so a replay with the same key should be free to
    // try again once the row is in a failed state.
    return c.json({ code: 'NOT_FOUND', message: 'Payout not found or not in failed state' }, 404);
  }
  log.info({ payoutId: id, adminUserId: actor.id }, 'Payout reset to pending by admin retry');

  const result = toView(row as PayoutRow);
  const envelope: AdminAuditEnvelope<AdminPayoutView> = buildAuditEnvelope({
    result,
    actor,
    idempotencyKey,
    appliedAt: new Date(),
    replayed: false,
  });

  try {
    await storeIdempotencyKey({
      adminUserId: actor.id,
      key: idempotencyKey,
      method: 'POST',
      path: endpointPath,
      status: 200,
      body: envelope as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.warn(
      { err, adminUserId: actor.id, key: idempotencyKey },
      'Failed to persist idempotency snapshot; retry will replay as new write',
    );
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    endpoint: `POST ${endpointPath}`,
    targetUserId: result.userId,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: false,
  });

  return c.json(envelope, 200);
}
