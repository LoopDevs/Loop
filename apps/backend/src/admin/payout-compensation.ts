/**
 * Admin payout-compensation endpoint (ADR-024 §5).
 *
 * `POST /api/admin/payouts/:id/compensate` — re-credits the user's
 * cashback balance after their queued withdrawal payout permanently
 * failed on-chain. Net result: the original `applyAdminWithdrawal`
 * debit is offset by a positive `type='adjustment'` row, leaving the
 * user's balance where it was before the doomed withdrawal attempt.
 *
 * Manual-only by design (Phase 2a). The on-chain payout worker keeps
 * `state='failed'` rows around so finance can review before triggering
 * compensation; an automatic sweep is deferred to a later ADR (see
 * ADR-024 §10 Deferred).
 *
 * Preconditions enforced here:
 *   - The payout exists.
 *   - `kind='withdrawal'` — order-cashback failures are a separate
 *     code path that doesn't run through this endpoint.
 *   - `state='failed'` — pending / submitted / confirmed payouts must
 *     not be compensated; that would double-credit a user whose
 *     payout is still in flight or has already settled.
 *
 * ADR-017 invariants:
 *   - Idempotency-Key required; replay returns the stored snapshot.
 *   - Reason 2..500 chars, persisted on the credit_transactions row
 *     and echoed in the Discord audit fanout.
 *   - Same `{ result, audit }` envelope as refund / adjustment / retry
 *     so the admin UI shares a single post-action renderer.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { isLoopAssetCode, currencyForLoopAsset } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { getPayoutForAdmin } from '../credits/pending-payouts.js';
import {
  AlreadyCompensatedError,
  applyAdminPayoutCompensation,
  PayoutNotCompensableError,
} from '../credits/payout-compensation.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-payout-compensation' });

const BodySchema = z.object({
  reason: z.string().min(2).max(500),
});

export interface PayoutCompensationResponse {
  id: string;
  payoutId: string;
  userId: string;
  currency: string;
  amountMinor: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

export async function adminPayoutCompensationHandler(c: Context): Promise<Response> {
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  const endpointPath = `/api/admin/payouts/${id}/compensate`;

  // A4-099: serialise lookup → write → store under an advisory
  // lock keyed on (actor, idempotencyKey). Pre-checks (payout
  // exists / kind=withdrawal / state=failed / assetCode known)
  // run inside the guard so the lock covers the full sequence.
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
        const payout = await getPayoutForAdmin(id);
        if (payout === null) {
          return {
            status: 404,
            body: { code: 'NOT_FOUND', message: 'Payout not found' },
          };
        }
        if (payout.kind !== 'withdrawal') {
          return {
            status: 400,
            body: {
              code: 'PAYOUT_NOT_COMPENSABLE',
              message:
                'Compensation only applies to withdrawal payouts; order-cashback failures use a different flow',
            },
          };
        }
        if (payout.state !== 'failed') {
          return {
            status: 409,
            body: {
              code: 'PAYOUT_NOT_COMPENSABLE',
              message: `Payout is in state '${payout.state}'; only 'failed' payouts can be compensated`,
            },
          };
        }
        if (!isLoopAssetCode(payout.assetCode)) {
          log.error(
            { payoutId: id, assetCode: payout.assetCode },
            'Payout has non-LOOP asset code; cannot derive home currency',
          );
          return {
            status: 500,
            body: { code: 'INTERNAL_ERROR', message: 'Payout asset code is not a LOOP asset' },
          };
        }
        const currency = currencyForLoopAsset(payout.assetCode);
        // 1 stroop = 0.00001 minor. The stroops-to-minor floor
        // mirrors the /100_000n factor applyAdminWithdrawal uses
        // in reverse — for any payout this primitive emitted the
        // conversion is exact.
        const amountMinor = payout.amountStroops / 100_000n;
        const applied = await applyAdminPayoutCompensation({
          userId: payout.userId,
          currency,
          amountMinor,
          payoutId: id,
          reason: parsed.data.reason,
        });
        const result: PayoutCompensationResponse = {
          id: applied.id,
          payoutId: applied.payoutId,
          userId: applied.userId,
          currency: applied.currency,
          amountMinor: applied.amountMinor.toString(),
          priorBalanceMinor: applied.priorBalanceMinor.toString(),
          newBalanceMinor: applied.newBalanceMinor.toString(),
          createdAt: applied.createdAt.toISOString(),
        };
        const envelope: AdminAuditEnvelope<PayoutCompensationResponse> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: applied.createdAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof AlreadyCompensatedError) {
      return c.json(
        {
          code: 'ALREADY_COMPENSATED',
          message: err.message,
        },
        409,
      );
    }
    if (err instanceof PayoutNotCompensableError) {
      return c.json(
        {
          code: 'PAYOUT_NOT_COMPENSABLE',
          message: err.message,
        },
        409,
      );
    }
    log.error({ err, payoutId: id, adminUserId: actor.id }, 'Compensation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to apply compensation' }, 500);
  }

  // Discord fanout — fire-and-forget AFTER commit per ADR 017 #5.
  // Only fans out for the success-shape envelope (200); the 4xx
  // envelopes are operator-correctable validation rejections that
  // shouldn't ping the audit channel.
  if (guardResult.status === 200) {
    const priorResult = (guardResult.body as { result?: PayoutCompensationResponse }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST ${endpointPath}`,
      ...(priorResult?.userId !== undefined ? { targetUserId: priorResult.userId } : {}),
      ...(priorResult?.amountMinor !== undefined ? { amountMinor: priorResult.amountMinor } : {}),
      ...(priorResult?.currency !== undefined ? { currency: priorResult.currency } : {}),
      reason: parsed.data.reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
