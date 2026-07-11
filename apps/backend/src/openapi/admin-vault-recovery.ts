/**
 * Admin vault-recovery OpenAPI registration (ADR 031 V7).
 *
 * Registers `POST /api/admin/vault-emissions/{id}/redrive` and
 * `POST /api/admin/vault-redemptions/{id}/redrive` plus their
 * locally-scoped body / result / envelope schemas — same split
 * pattern as `admin-order-redrive.ts`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers both vault-recovery paths on the supplied registry.
 * Called once from `registerAdminOpenApi`.
 */
export function registerAdminVaultRecoveryOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const VaultRedriveBody = registry.register(
    'VaultRedriveBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const AdminVaultEmissionRedriveResult = registry.register(
    'AdminVaultEmissionRedriveResult',
    z.object({
      vaultEmissionId: z.string().uuid(),
      orderId: z.string().uuid(),
      priorState: z.string().openapi({
        description:
          "The row's state at the moment this redrive call was received (e.g. 'failed').",
      }),
      resumedFromState: z.string().openapi({
        description:
          'The state driveOneVaultEmission was actually invoked from — proves which (if any) completed on-chain step was skipped on resume.',
      }),
      outcome: z.enum([
        'depositing',
        'deposited',
        'transferred',
        'mirrored',
        'failed',
        'no_vault',
        'claimed_elsewhere',
      ]),
      state: z.string().openapi({
        description: 'Row state re-read fresh from the DB after the attempt.',
      }),
      attempts: z.number().int().nonnegative(),
    }),
  );

  const AdminVaultEmissionRedriveEnvelope = registry.register(
    'AdminVaultEmissionRedriveEnvelope',
    z.object({ result: AdminVaultEmissionRedriveResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/vault-emissions/{id}/redrive',
    summary: 'Re-drive a failed/stuck vault-emission row (ADR 031 V7).',
    description:
      "Re-enters the row's EXISTING drive (`driveOneVaultEmission`) — never a hand-rolled flow. For a `failed` row, the resume state is inferred from persisted on-chain LANDING markers (`depositedAt`/`transferredAt`, set only once a step's on-chain action + DB commit both succeeded), never blindly reset to `pending` — so a completed deposit/transfer is verified via the existing CF-18 `priorTxHash` contract, never re-submitted. A row that is not `failed` but sitting in a live state (operator-confirmed-stuck, e.g. the sweep has been down) is driven as-is with no state mutation. Serialised against the emission sweep via its fleet-wide advisory lock (money-review #1652 P1): a reclaimed row skips the `pending→depositing` CAS, so an un-serialised re-drive racing the sweep on the same step would be a double-deposit/double-transfer vector — the re-drive acquires the SAME lock and 409s `VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS` when the sweep holds it. Refuses (409) an already-`mirrored` row. Admin-tier + step-up (`vault-redrive` scope) — like order-redrive, this can submit a real outbound Soroban call. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: VaultRedriveBody } },
      },
    },
    responses: {
      200: {
        description: 'Redrive applied (or replayed from snapshot)',
        content: { 'application/json': { schema: AdminVaultEmissionRedriveEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or malformed id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such vault emission',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Vault emission already `mirrored` (`VAULT_EMISSION_ALREADY_MIRRORED`), changed state mid-redrive (`VAULT_EMISSION_REDRIVE_RACE`, likely a concurrent redrive), or the emission sweep currently holds the single-flight lock the re-drive must serialise against (`VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS` — retry once the sweep releases)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error redriving the vault emission (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const AdminVaultRedemptionRedriveResult = registry.register(
    'AdminVaultRedemptionRedriveResult',
    z.object({
      vaultRedemptionId: z.string().uuid(),
      sourceType: z.string(),
      sourceId: z.string().uuid(),
      priorState: z.string(),
      resumedFromState: z.string(),
      outcome: z.enum([
        'collecting',
        'redeemed',
        'settled',
        'failed',
        'no_vault',
        'claimed_elsewhere',
      ]),
      state: z.string(),
      attempts: z.number().int().nonnegative(),
    }),
  );

  const AdminVaultRedemptionRedriveEnvelope = registry.register(
    'AdminVaultRedemptionRedriveEnvelope',
    z.object({ result: AdminVaultRedemptionRedriveResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/vault-redemptions/{id}/redrive',
    summary: 'Re-drive a failed/stuck vault-redemption row (ADR 031 V7).',
    description:
      "Re-enters the row's EXISTING drive (`driveOneVaultRedemption`). A `failed` row resumes from `redeemedAt` (set only once the payout landed) — resuming at `redeemed` re-runs only the mirror step; resuming at `collecting` lets the existing branch skip a landed collect and go straight to payout, or verify-or-resubmit an in-flight one. A row whose failure carries the `markRedemptionNeedsRefund` signature (payout already landed, source order no longer payable, mirror deliberately not debited) is REFUSED with 409 and its needs-refund status surfaced, rather than silently re-attempting a payout that would just fail identically again. A row in a live non-terminal state (operator-confirmed-stuck) is driven as-is. Refuses (409) an already-`settled` row. Admin-tier + step-up (`vault-redrive` scope, shared with the emission-side endpoint). ADR 017 compliant.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: VaultRedriveBody } },
      },
    },
    responses: {
      200: {
        description: 'Redrive applied (or replayed from snapshot)',
        content: { 'application/json': { schema: AdminVaultRedemptionRedriveEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or malformed id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such vault redemption',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Vault redemption already `settled` (`VAULT_REDEMPTION_ALREADY_SETTLED`), needs a manual refund (`VAULT_REDEMPTION_NEEDS_REFUND`), or changed state mid-redrive (`VAULT_REDEMPTION_REDRIVE_RACE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error redriving the vault redemption (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
