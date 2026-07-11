/**
 * Admin vault-EMISSION re-drive lever (ADR 031 V7 — the recovery
 * complement to the V5a stuck-emission-watchdog page). Mirrors
 * `admin/order-redrive.ts`'s shape (ADR 017 envelope, ADR 028
 * step-up) applied to the vault-emission state machine instead of
 * the classic order/procurement path.
 *
 * `POST /api/admin/vault-emissions/:id/redrive` — a `failed` vault
 * emission (attempts-exhausted after `VAULT_EMISSION_MAX_ATTEMPTS`
 * consecutive step failures — `credits/vaults/vault-emissions.ts`) is
 * deliberately NOT auto-retried by the sweep; before this endpoint the
 * only lever was raw SQL. This handler re-enters the row's EXISTING
 * drive (`driveOneVaultEmission`) — it does NOT hand-roll a new flow.
 *
 * ── Never re-does a completed on-chain step ─────────────────────────
 * For a `failed` row, `reclaimFailedVaultEmissionForRedrive` (in
 * `vault-emissions.ts`) infers the correct resume state from the
 * row's persisted `depositedAt`/`transferredAt` LANDING markers (set
 * ONLY once a step's on-chain action + DB commit both succeeded — see
 * that function's doc comment for the full reasoning), never from
 * `pending` — a `failed` emission was always already at least
 * `depositing` (the `pending → depositing` claim is a direct CAS, not
 * a `recordStepFailure` caller). The reclaimed row is then driven via
 * the UNMODIFIED `driveOneVaultEmission`, which re-enters at the
 * resumed step and threads the SAME CF-18 `priorTxHash`
 * verify-or-resubmit contract every automatic resume already relies
 * on — a landed deposit/transfer is verified, never blindly re-signed.
 *
 * A row that is NOT `failed` but is sitting in a live state
 * (`pending`/`depositing`/`deposited`/`transferred` — "operator-
 * confirmed-stuck", e.g. the sweep worker has been down past the V5a
 * watchdog threshold) is driven AS-IS with no state mutation — exactly
 * what the next sweep tick would have done.
 *
 * ── Residual risk (flag explicitly for money-review) ────────────────
 * Unlike `vault-redemptions.ts` (V4, explicitly designed for two
 * concurrent drivers — see its module header's "Concurrency: two
 * drivers, three guards"), V3's `vault-emissions.ts` was designed
 * assuming the sweep is the ONLY driver for `depositing`/`deposited`/
 * `transferred` rows. This endpoint becomes an occasional SECOND
 * driver for those states. The reasoning this is still safe: every
 * on-chain call in `depositStep`/`transferStep` is a Stellar
 * transaction against the operator's account sequence number — if
 * this handler's drive and a concurrent sweep tick both attempt the
 * SAME step, at most one of their competing transactions can ever
 * land (Horizon rejects the loser's stale-sequence submission), so a
 * double-deposit / double-transfer of value cannot actually happen —
 * the loser's attempt fails as an ordinary retryable error, exactly
 * the SAME class of risk `vault-emissions.ts`'s module header already
 * documents + accepts for the sweep-vs-classic-payout-worker
 * cross-race. This endpoint does not introduce a NEW class of risk,
 * only a new (rate-limited, step-up-gated, human-triggered) occasion
 * for the SAME accepted one.
 *
 * Admin-tier + step-up (`'vault-redrive'` scope) — this can submit a
 * real outbound Soroban deposit/transfer call.
 */
import type { Context } from 'hono';
import type { AdminVaultEmissionRedriveResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import type { User } from '../db/users.js';
import {
  getVaultEmissionById,
  reclaimFailedVaultEmissionForRedrive,
  driveOneVaultEmission,
  type VaultEmissionRow,
} from '../credits/vaults/vault-emissions.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-vault-emission-redrive' });

/**
 * Control-flow escape for the not-applicable outcomes — thrown from
 * inside the idempotency guard so no failure snapshot is stored (a
 * transient-state 404/409 must never replay once the row's real state
 * has moved on).
 */
class RedriveNotApplicableError extends Error {
  constructor(readonly kind: 'not_found' | 'already_mirrored' | 'race_changed') {
    super(`vault emission redrive not applicable: ${kind}`);
    this.name = 'RedriveNotApplicableError';
  }
}

export async function adminRedriveVaultEmissionHandler(c: Context): Promise<Response> {
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
        path: `/api/admin/vault-emissions/${id}/redrive`,
      },
      async () => {
        const existing = await getVaultEmissionById(id);
        if (existing === null) {
          throw new RedriveNotApplicableError('not_found');
        }
        if (existing.state === 'mirrored') {
          throw new RedriveNotApplicableError('already_mirrored');
        }

        const priorState = existing.state;
        let toDrive: VaultEmissionRow;
        let resumedFromState: string;
        if (existing.state === 'failed') {
          const reclaimed = await reclaimFailedVaultEmissionForRedrive(id);
          if (reclaimed.kind !== 'reclaimed') {
            // Raced a concurrent redrive between our read above and the
            // reclaim's own locked re-read — the row moved out of
            // 'failed' in between. Not applicable any more; the caller
            // should re-check the row's current state.
            throw new RedriveNotApplicableError('race_changed');
          }
          toDrive = reclaimed.row;
          resumedFromState = reclaimed.row.state;
        } else {
          // Operator-confirmed-stuck: a live non-terminal state
          // (pending/depositing/deposited/transferred) the sweep hasn't
          // finished draining — drive as-is, no state mutation. This is
          // exactly what the next sweep tick would do.
          toDrive = existing;
          resumedFromState = existing.state;
        }

        const outcome = await driveOneVaultEmission(toDrive);

        const finalRow = await getVaultEmissionById(id);
        const result: AdminVaultEmissionRedriveResult = {
          vaultEmissionId: id,
          orderId: existing.orderId,
          priorState,
          resumedFromState,
          outcome,
          state: finalRow?.state ?? toDrive.state,
          attempts: finalRow?.attempts ?? toDrive.attempts,
        };
        log.info(
          {
            vaultEmissionId: id,
            adminUserId: actor.id,
            priorState,
            resumedFromState,
            outcome,
            finalState: result.state,
          },
          'Admin vault emission redrive applied',
        );
        const envelope: AdminAuditEnvelope<AdminVaultEmissionRedriveResult> = buildAuditEnvelope({
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
    if (err instanceof RedriveNotApplicableError) {
      if (err.kind === 'not_found') {
        return c.json({ code: 'NOT_FOUND', message: 'Vault emission not found' }, 404);
      }
      if (err.kind === 'already_mirrored') {
        return c.json(
          {
            code: 'VAULT_EMISSION_ALREADY_MIRRORED',
            message: 'Vault emission has already mirrored — nothing to redrive.',
          },
          409,
        );
      }
      // race_changed
      return c.json(
        {
          code: 'VAULT_EMISSION_REDRIVE_RACE',
          message:
            'Vault emission changed state during this redrive (likely a concurrent redrive) — re-check its current state before retrying.',
        },
        409,
      );
    }
    log.error(
      { err, vaultEmissionId: id, actorUserId: actor.id },
      'Admin vault emission redrive failed',
    );
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to redrive vault emission' }, 500);
  }

  if (guardResult.status === 200) {
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/vault-emissions/${id}/redrive`,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 404 | 409 | 500);
}
