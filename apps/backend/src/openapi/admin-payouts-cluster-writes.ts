/**
 * Admin payouts-cluster write OpenAPI registrations
 * (ADR 017 retry, ADR-024 §5 compensate).
 *
 * Lifted out of `apps/backend/src/openapi/admin-payouts-cluster.ts`
 * so the four read paths in that file (the backlog / drill /
 * by-asset / settlement-lag aggregates) sit alongside their
 * read-only schemas, and the two write paths sit here with their
 * ADR-017-shaped body / envelope schemas. Both halves keep the
 * same `errorResponse + adminPayoutView + adminWriteAudit`
 * dependency-threading pattern as the parent slice.
 *
 * Re-invoked from `registerAdminPayoutsClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `POST /api/admin/payouts/{id}/retry` and
 * `POST /api/admin/payouts/{id}/compensate` plus their locally-
 * scoped body / envelope schemas on the supplied registry.
 */
export function registerAdminPayoutsClusterWritesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminPayoutView: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminPayoutView = adminPayoutView;
  const AdminWriteAudit = adminWriteAudit;

  const PayoutRetryBody = registry.register(
    'PayoutRetryBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutRetryEnvelope = registry.register(
    'PayoutRetryEnvelope',
    z.object({
      result: AdminPayoutView,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/retry',
    summary: 'Flip a failed payout back to pending (ADR 015 / 016 / 017).',
    description:
      'Admin-only manual retry: resets a `failed` pending_payouts row to `pending` so the submit worker picks it up on the next tick. 404 when the id matches nothing or the row is in a non-failed state. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. Worker enforces memo-idempotency on re-submit (ADR 016) so double-retry never double-pays.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutRetryBody } },
      },
    },
    responses: {
      200: {
        description: 'Retry applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutRetryEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or malformed id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Payout not found or not in failed state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resetting the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PayoutCompensationBody = registry.register(
    'PayoutCompensationBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutCompensationResult = registry.register(
    'PayoutCompensationResult',
    z.object({
      id: z.string().uuid(),
      payoutId: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      amountMinor: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const PayoutCompensationEnvelope = registry.register(
    'PayoutCompensationEnvelope',
    z.object({
      result: PayoutCompensationResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/compensate',
    summary: 'Compensate a permanently-failed withdrawal payout (ADR-024 §5).',
    description:
      'Re-credits the user after their withdrawal payout permanently failed on-chain. Writes a positive `type=adjustment` row referencing the payout id; net result is the original withdrawal debit is offset and the user is back to where they started. Manual-only (Phase 2a) — finance reviews failures before triggering. 400 if the payout is not a withdrawal; 409 if the payout is in any state other than `failed`. ADR 017 compliant: `Idempotency-Key` header + `reason` body required.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutCompensationBody } },
      },
    },
    responses: {
      200: {
        description: 'Compensation applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutCompensationEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid reason, malformed id, or payout is not a withdrawal',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Payout not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: "Payout is not in 'failed' state — only failed payouts can be compensated",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying compensation',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
