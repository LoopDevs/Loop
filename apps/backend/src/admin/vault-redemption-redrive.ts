/**
 * Admin vault-REDEMPTION re-drive lever (ADR 031 V7 — the recovery
 * complement to the V5a stuck-redemption-watchdog page). Mirrors
 * `admin/vault-emission-redrive.ts`'s shape applied to the
 * vault-redemption state machine (`credits/vaults/vault-redemptions.ts`).
 *
 * `POST /api/admin/vault-redemptions/:id/redrive` — a `failed` vault
 * redemption (attempts-exhausted after
 * `VAULT_REDEMPTION_MAX_ATTEMPTS`) is deliberately NOT auto-retried by
 * the sweep. This handler re-enters the row's EXISTING drive
 * (`driveOneVaultRedemption`) — it does NOT hand-roll a new flow.
 *
 * ── Never re-does a completed on-chain step ─────────────────────────
 * `reclaimFailedVaultRedemptionForRedrive` (in `vault-redemptions.ts`)
 * infers the resume state from `redeemedAt` — set ONLY once the
 * payout itself has landed — never from `collectTxHash`/`payoutPath`
 * alone (those can be set by an in-flight/aborted attempt via CF-18
 * `onSigned`). A row with `redeemedAt` set resumes at `'redeemed'`
 * (only `mirrorStep` re-runs — the collect + payout are never
 * repeated); otherwise it resumes at `'collecting'`, where
 * `driveOneVaultRedemption`'s existing branch already does the right
 * thing without help: `collectSharesStep` no-ops instantly if
 * `collectedAt` is already set (falling straight to `payoutStep`,
 * i.e. NO re-collect), or re-claims + verify-or-resubmits the collect
 * transfer via `priorTxHash` if it isn't.
 *
 * ── needs-refund rows are refused, not silently re-paid ─────────────
 * A `failed` row whose `lastError` carries the
 * `markRedemptionNeedsRefund` signature
 * (`isVaultRedemptionNeedsRefund`, `vault-redemptions.ts`) means the
 * payout ALREADY landed but the source order was no longer payable at
 * mirror time — the mirror debit was deliberately never applied and
 * the collected shares need a MANUAL refund. Retrying would just hit
 * the identical `VaultRedemptionOrderNotPayableError` again (the
 * order's non-payable state doesn't change on retry) and re-page ops
 * for nothing — this handler detects it and returns 409 with the
 * needs-refund status instead of driving the row at all.
 *
 * A row that is NOT `failed` but sitting in a live state
 * (`pending`/`collecting`/`redeemed` — operator-confirmed-stuck) is
 * driven AS-IS, no state mutation — `driveOneVaultRedemption` is
 * explicitly designed for concurrent callers (its own module header:
 * "Concurrency: two drivers, three guards"), so calling it inline here
 * alongside a live sweep is the SAME safety property the HTTP inline
 * redeem-time drive already relies on, not a new risk.
 *
 * Admin-tier + step-up (`'vault-redrive'` scope, shared with the
 * emission-side endpoint) — this can submit a real outbound Soroban
 * collect/withdraw call.
 */
import type { Context } from 'hono';
import type { AdminVaultRedemptionRedriveResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import {
  getVaultRedemptionById,
  reclaimFailedVaultRedemptionForRedrive,
  driveOneVaultRedemption,
  type VaultRedemptionRow,
} from '../credits/vaults/vault-redemptions.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  assertAdminActionValueWithinCap,
  AdminActionValueCapExceededError,
} from './action-value-cap.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-vault-redemption-redrive' });

class RedriveNotApplicableError extends Error {
  constructor(readonly kind: 'not_found' | 'already_settled' | 'needs_refund' | 'race_changed') {
    super(`vault redemption redrive not applicable: ${kind}`);
    this.name = 'RedriveNotApplicableError';
  }
}

export async function adminRedriveVaultRedemptionHandler(c: Context): Promise<Response> {
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
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/vault-redemptions/${id}/redrive`,
      },
      async () => {
        const existing = await getVaultRedemptionById(id);
        if (existing === null) {
          throw new RedriveNotApplicableError('not_found');
        }
        if (existing.state === 'settled') {
          throw new RedriveNotApplicableError('already_settled');
        }

        // NS-05: bound the value this redrive can collect/pay out
        // on-chain BEFORE `driveOneVaultRedemption` submits. `valueMinor`
        // is already in the vault currency's (USD/EUR) minor units, so
        // the cap is compared per-currency. Thrown inside the guard →
        // txn rolls back, no snapshot stored, mapped to 422.
        assertAdminActionValueWithinCap({
          valueMinor: existing.valueMinor,
          currency: existing.assetCode,
        });

        const priorState = existing.state;
        let toDrive: VaultRedemptionRow;
        let resumedFromState: string;
        if (existing.state === 'failed') {
          const reclaimed = await reclaimFailedVaultRedemptionForRedrive(id);
          if (reclaimed.kind === 'needs_refund') {
            throw new RedriveNotApplicableError('needs_refund');
          }
          if (reclaimed.kind !== 'reclaimed') {
            throw new RedriveNotApplicableError('race_changed');
          }
          toDrive = reclaimed.row;
          resumedFromState = reclaimed.row.state;
        } else {
          // Operator-confirmed-stuck: pending/collecting/redeemed — drive
          // as-is, no state mutation.
          toDrive = existing;
          resumedFromState = existing.state;
        }

        const outcome = await driveOneVaultRedemption(toDrive);

        const finalRow = await getVaultRedemptionById(id);
        const result: AdminVaultRedemptionRedriveResult = {
          vaultRedemptionId: id,
          sourceType: existing.sourceType,
          sourceId: existing.sourceId,
          priorState,
          resumedFromState,
          outcome,
          state: finalRow?.state ?? toDrive.state,
          attempts: finalRow?.attempts ?? toDrive.attempts,
        };
        log.info(
          {
            vaultRedemptionId: id,
            adminUserId: actor.id,
            priorState,
            resumedFromState,
            outcome,
            finalState: result.state,
          },
          'Admin vault redemption redrive applied',
        );
        const envelope: AdminAuditEnvelope<AdminVaultRedemptionRedriveResult> = buildAuditEnvelope({
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
      // NS-05: no money moved — the guard rolled back before the drive.
      return c.json({ code: 'ADMIN_ACTION_VALUE_CAP_EXCEEDED', message: err.message }, 422);
    }
    if (err instanceof RedriveNotApplicableError) {
      if (err.kind === 'not_found') {
        return c.json({ code: 'NOT_FOUND', message: 'Vault redemption not found' }, 404);
      }
      if (err.kind === 'already_settled') {
        return c.json(
          {
            code: 'VAULT_REDEMPTION_ALREADY_SETTLED',
            message: 'Vault redemption has already settled — nothing to redrive.',
          },
          409,
        );
      }
      if (err.kind === 'needs_refund') {
        return c.json(
          {
            code: 'VAULT_REDEMPTION_NEEDS_REFUND',
            message:
              'This redemption already paid out (shares collected, value paid) but its source order was no longer payable — the mirror debit was NOT applied and the collected shares need a MANUAL refund. Re-driving would hit the same non-payable order again; it is refused rather than silently re-attempting a payout.',
          },
          409,
        );
      }
      // race_changed
      return c.json(
        {
          code: 'VAULT_REDEMPTION_REDRIVE_RACE',
          message:
            'Vault redemption changed state during this redrive (likely a concurrent redrive) — re-check its current state before retrying.',
        },
        409,
      );
    }
    log.error(
      { err, vaultRedemptionId: id, actorUserId: actor.id },
      'Admin vault redemption redrive failed',
    );
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to redrive vault redemption' }, 500);
  }

  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/vault-redemptions/${id}/redrive`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
