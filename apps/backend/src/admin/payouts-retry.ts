/**
 * `POST /api/admin/payouts/:id/retry` — admin-only retry of a
 * failed `pending_payouts` row.
 *
 * Lifted out of `apps/backend/src/admin/payouts.ts`. ADR 017
 * compliant: actor from `requireAdmin`, `Idempotency-Key` header
 * required, `reason` body (2-500 chars), snapshot replay on
 * repeat, Discord audit fanout AFTER commit. Response envelope is
 * `{ result, audit }` to match the credit-adjustment write so the
 * admin UI renders both the same way.
 *
 * Pulled out of the read-only payouts handler file because retry
 * is the only ADR-017-shaped write surface in there — it carries
 * idempotency-key + audit-envelope plumbing the four other handlers
 * (list / get / by-order) don\'t need.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { UUID_RE } from '../uuid.js';
import { resetPayoutToPending } from '../credits/pending-payouts.js';
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
import { type AdminPayoutView } from './payouts.js';

const log = logger.child({ handler: 'admin-payouts-retry' });

// `toView` lives in the parent file — re-shape a fresh DB row into
// the wire view. Re-importing keeps the slice signature short
// (the caller passes the row, not the shaped view).
interface PayoutRow {
  id: string;
  userId: string;
  orderId: string | null;
  kind: 'order_cashback' | 'withdrawal';
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
    kind: row.kind,
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
    endpoint: `POST ${endpointPath}`,
    targetUserId: result.userId,
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: false,
  });

  return c.json(envelope, 200);
}
