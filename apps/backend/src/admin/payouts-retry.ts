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

/**
 * Walks the drizzle → postgres-js cause chain for the
 * `assert_emission_conservation()` trigger's check_violation (raised
 * with an `emission_conservation:` message prefix).
 */
function isEmissionConservationViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message.includes('emission_conservation')) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  assertAdminActionValueWithinCap,
  AdminActionValueCapExceededError,
  stroopsToMinorFloor,
} from './action-value-cap.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';
import { type AdminPayoutView } from './payouts.js';

const log = logger.child({ handler: 'admin-payouts-retry' });

/**
 * Sentinel thrown from inside the `withIdempotencyGuard` write
 * callback when `resetPayoutToPending` matches no `failed` row.
 * Throwing (instead of returning a 404 result) rolls the guard txn
 * back, so the 404 is NOT snapshot-stored — a replay with the same
 * key stays free to try again once the row is back in a failed
 * state. Returning would persist the 404 and pin the key to it.
 */
class PayoutNotRetryableError extends Error {
  constructor(public readonly payoutId: string) {
    super(`Payout ${payoutId} not found or not in failed state`);
    this.name = 'PayoutNotRetryableError';
  }
}

// `toView` lives in the parent file — re-shape a fresh DB row into
// the wire view. Re-importing keeps the slice signature short
// (the caller passes the row, not the shaped view).
interface PayoutRow {
  id: string;
  userId: string;
  orderId: string | null;
  kind: 'order_cashback' | 'emission' | 'burn' | 'interest_mint';
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

  // lookup → reset → store used to be three unguarded steps,
  // so two concurrent same-key retries could both miss the lookup and
  // both reset (and a crash between reset and store lost the replay
  // record). `withIdempotencyGuard` serialises the whole sequence
  // under a pg advisory lock and persists the snapshot in the same
  // txn — identical ladder to the credit-adjustment / compensation
  // writes. A snapshot hit replays the stored envelope with
  // `audit.replayed: true` flipped by the guard.
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
        const row = await resetPayoutToPending(id);
        if (row === null) {
          // Thrown (not returned) so the 404 isn't snapshot-stored —
          // see PayoutNotRetryableError above.
          throw new PayoutNotRetryableError(id);
        }
        // NS-05: bound the value this retry re-queues for the submit
        // worker. The pinned `amountStroops` is on-chain stroops of a
        // fiat-pegged LOOP asset (`assetCode`, e.g. USDLOOP = $1:1) —
        // convert to that currency's minor units and cap per-currency.
        // Thrown here → the guard txn rolls back the failed→pending flip
        // (nothing is left for the worker to pick up) and stores no
        // snapshot; the outer catch maps it to a 422.
        assertAdminActionValueWithinCap({
          valueMinor: stroopsToMinorFloor(row.amountStroops),
          currency: row.assetCode,
        });
        log.info({ payoutId: id, adminUserId: actor.id }, 'Payout reset to pending by admin retry');
        const result = toView(row as PayoutRow);
        const envelope: AdminAuditEnvelope<AdminPayoutView> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof AdminActionValueCapExceededError) {
      // NS-05: no money moved — the guard rolled back the failed→pending
      // flip, so the submit worker never sees this row.
      return c.json({ code: 'ADMIN_ACTION_VALUE_CAP_EXCEEDED', message: err.message }, 422);
    }
    if (err instanceof PayoutNotRetryableError) {
      return c.json({ code: 'NOT_FOUND', message: 'Payout not found or not in failed state' }, 404);
    }
    if (isEmissionConservationViolation(err)) {
      // Hardening A1/C10: the re-entry conservation trigger rejected
      // the failed → pending flip. The row's headroom was legitimately
      // re-consumed while it sat failed (typically a backfill emission
      // was issued instead) — retrying it now would mint BOTH.
      log.warn({ payoutId: id, adminUserId: actor.id }, 'Payout retry rejected by conservation');
      return c.json(
        {
          code: 'EMISSION_EXCEEDS_UNEMITTED_BALANCE',
          message:
            'Retrying this payout would exceed the un-emitted liability — its value was already re-materialised (e.g. via a backfill emission) while it sat failed. Compensate or investigate instead of retrying.',
        },
        409,
      );
    }
    log.error({ err, payoutId: id }, 'Admin retry failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to retry payout' }, 500);
  }

  // Discord fanout — fire-and-forget AFTER commit per ADR 017 #5.
  // Fires for fresh writes and replays alike (so ops sees the second
  // click), but not for the corrupt-snapshot 500 the guard can emit.
  if (guardResult.status === 200) {
    const priorResult = (guardResult.body as { result?: AdminPayoutView }).result;
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST ${endpointPath}`,
      ...(priorResult?.userId !== undefined ? { targetUserId: priorResult.userId } : {}),
      reason: parsed.data.reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 500);
}
