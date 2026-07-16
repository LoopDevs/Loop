/**
 * `POST /api/admin/deposits/:paymentId/refund` (hardening A6).
 *
 * Operator-triggered refund of an abandoned late deposit back to its
 * on-chain sender. Admin-tier + step-up (`'deposit-refund'` scope) —
 * the outbound Stellar payment from the operator account is exactly
 * the stolen-bearer threat ADR 028 exists for. The heavy lifting
 * (validation, CAS claim, CF-18 crash-safe submit, idempotent replay)
 * lives in `payments/deposit-refund.ts`; this maps its tagged result
 * to an HTTP status.
 *
 * ADR-017 envelope (MNY-13): like every OTHER admin money-move
 * (order-refund / payout-compensation / emission / credit-adjustment)
 * this write is now wrapped in the shared idempotency + audit envelope
 * — an `Idempotency-Key` fence (a double-submit / replay with the same
 * key collapses to the stored snapshot without re-invoking the
 * refund), a required captured `reason`, the `admin_idempotency_keys`
 * audit-log row (the durable admin-write trail `admin/audit-tail.ts`
 * reads), and the Discord ops fanout (`notifyAdminAudit`). The refund
 * primitive itself has an independent on-chain idempotency guard
 * (Horizon memo-scan + CAS claim), so the ADR-017 fence here is the
 * ADMIN-edge dedup + audit trail, mirroring the sibling handlers.
 *
 * The primitive can't persist the operator's captured reason on a
 * ledger row (the way `applyAdminRefund` / `applyAdminPayoutCompensation`
 * do — a late deposit has no `credit_transactions` row), so the reason
 * is durably captured on the `admin_idempotency_keys` snapshot (it
 * rides in the response envelope, which the guard serialises into that
 * row's `response_body`) and echoed in the Discord audit fanout.
 */
import type { Context } from 'hono';
import { refundDeposit } from '../payments/deposit-refund.js';
import { RailHaltedError } from '../rail-kill-switches/index.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { z } from 'zod';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'deposit-refund' });

const BodySchema = z.object({
  reason: z.string().min(2).max(500),
});

export interface DepositRefundResponse {
  paymentId: string;
  status: 'refunded' | 'already_refunded';
  txHash: string;
  /**
   * The operator's captured reason. Echoed into the result so it is
   * persisted on the `admin_idempotency_keys` audit-log snapshot —
   * the durable capture point for the deposit-refund envelope, since
   * (unlike its sibling money-moves) this write has no ledger row to
   * stamp the reason onto.
   */
  reason: string;
}

/**
 * Control-flow escape for the non-success refund outcomes — thrown
 * from inside the idempotency guard so NO failure snapshot is stored.
 * A transient / current-state outcome (`in_progress`, `submit_failed`,
 * `not_found`, `not_refundable`) must never replay once the deposit's
 * real state has moved on — the caller re-POSTs with the same key and
 * the refund is re-evaluated. Same pattern as `order-refund.ts`'s
 * `OrderRefundNotApplicableError`.
 */
class DepositRefundNotApplicableError extends Error {
  constructor(
    readonly kind: 'not_found' | 'in_progress' | 'not_refundable' | 'submit_failed',
    readonly detail?: string,
  ) {
    super(`deposit refund not applicable: ${kind}`);
    this.name = 'DepositRefundNotApplicableError';
  }
}

export async function adminDepositRefundHandler(c: Context): Promise<Response> {
  const paymentId = c.req.param('paymentId');
  if (paymentId === undefined || paymentId.length === 0 || paymentId.length > 128) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'paymentId is required' }, 400);
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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }
  const { reason } = parsed.data;

  const endpointPath = `/api/admin/deposits/${paymentId}/refund`;

  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: endpointPath,
      },
      async () => {
        const result = await refundDeposit(paymentId);
        switch (result.kind) {
          case 'refunded':
          case 'already_refunded': {
            log.warn(
              { paymentId, adminUserId: actor.id, txHash: result.txHash, replay: result.kind },
              'A6: admin refunded a late deposit to its sender',
            );
            const body: DepositRefundResponse = {
              paymentId,
              status: result.kind,
              txHash: result.txHash,
              reason,
            };
            const envelope: AdminAuditEnvelope<DepositRefundResponse> = buildAuditEnvelope({
              result: body,
              actor,
              idempotencyKey,
              appliedAt: new Date(),
              replayed: false,
            });
            return { status: 200, body: envelope as unknown as Record<string, unknown> };
          }
          case 'not_found':
            throw new DepositRefundNotApplicableError('not_found');
          case 'in_progress':
            throw new DepositRefundNotApplicableError('in_progress');
          case 'not_refundable':
            throw new DepositRefundNotApplicableError('not_refundable', result.detail);
          case 'submit_failed':
            throw new DepositRefundNotApplicableError('submit_failed', result.detail);
        }
      },
    );
  } catch (err) {
    // NS-04: refund rail halted — no NEW on-chain deposit refund starts.
    // 503 transient-retry; the throw rolled the guard txn back so no
    // snapshot persisted, and a retry after resume re-evaluates cleanly.
    if (err instanceof RailHaltedError) {
      return c.json(
        { code: 'RAIL_HALTED', message: `${err.rail} rail is temporarily halted — retry shortly` },
        503,
      );
    }
    if (err instanceof DepositRefundNotApplicableError) {
      switch (err.kind) {
        case 'not_found':
          return c.json({ code: 'NOT_FOUND', message: 'No skipped deposit with that id' }, 404);
        case 'in_progress':
          return c.json(
            {
              code: 'PAYMENT_IN_FLIGHT',
              message: 'A refund for this deposit is already in progress',
            },
            409,
          );
        case 'not_refundable':
          return c.json(
            { code: 'DEPOSIT_NOT_REFUNDABLE', message: `Not refundable: ${err.detail ?? ''}` },
            409,
          );
        case 'submit_failed':
          return c.json(
            {
              code: 'REFUND_SUBMIT_FAILED',
              message: `Refund submit failed: ${err.detail ?? ''}`,
            },
            502,
          );
      }
    }
    log.error({ err, paymentId, adminUserId: actor.id }, 'A6: deposit refund crashed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refund failed' }, 500);
  }

  // Discord fanout — fire-and-forget AFTER commit per ADR 017 #5. Only
  // the success-shape envelope (200) reaches here; the non-applicable
  // outcomes returned above never ping the audit channel.
  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST ${endpointPath}`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 404 | 409 | 500 | 502);
}
