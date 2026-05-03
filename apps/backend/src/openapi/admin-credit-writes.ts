/**
 * Admin credit-write OpenAPI registrations
 * (ADR 017 / 024 / A2-901).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. The three
 * admin-mediated write surfaces — credit-adjustment, refund,
 * withdrawal — share the ADR-017 admin-write contract: actor
 * from `requireAdmin`, `Idempotency-Key` header, `reason` body
 * field, append-only ledger, Discord audit fanout AFTER commit,
 * and the uniform `{ result, audit }` envelope.
 *
 * Co-locating them mirrors how operators read these surfaces —
 * the admin UI's "user actions" panel exposes adjustment / refund
 * / withdrawal as one row of three buttons.
 *
 * Paths registered directly here:
 *   - POST /api/admin/users/{userId}/credit-adjustments
 *   - POST /api/admin/users/{userId}/refunds                (A2-901)
 *
 * Six locally-scoped schemas travel with the slice:
 *   - CreditAdjustmentBody / Result / Envelope
 *   - RefundBody / Result / Envelope
 *
 * The third write — withdrawal (ADR-024) — has its own slice in
 * `./admin-withdrawal-write.ts` and is fanned out via the
 * `registerAdminWithdrawalWriteOpenApi` call below. The
 * three-write façade is preserved by keeping that fan-out inside
 * this factory: callers in `admin.ts` still see one registration
 * call for the entire admin-write surface.
 *
 * `AdminWriteAudit` stays in admin.ts because it is shared with
 * the cashback-config slice (#1166). Threaded into both slices as
 * a parameter so each side keeps the same registered schema
 * instance — the third consumer joins the same threading pattern
 * already established for `adminSupplierSpendRow` (#1172/#1173).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminWithdrawalWriteOpenApi } from './admin-withdrawal-write.js';

/**
 * Registers the admin-write paths + their locally-scoped schemas
 * on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminCreditWritesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local alias preserves the PascalCase identifier the body
  // used pre-decomposition.
  const AdminWriteAudit = adminWriteAudit;

  const CreditAdjustmentBody = registry.register(
    'CreditAdjustmentBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Signed integer-as-string. Non-zero, within ±10_000_000 minor units. Positive = credit, negative = debit.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      reason: z.string().min(2).max(500),
    }),
  );

  const CreditAdjustmentResult = registry.register(
    'CreditAdjustmentResult',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const CreditAdjustmentEnvelope = registry.register(
    'CreditAdjustmentEnvelope',
    z.object({
      result: CreditAdjustmentResult,
      audit: AdminWriteAudit,
    }),
  );

  // A2-901 — admin refund write.
  const RefundBody = registry.register(
    'RefundBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Positive integer-as-string. 1..10_000_000 minor units. Refunds are credit-only; a debit should be a credit adjustment.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      orderId: z.string().uuid(),
      reason: z.string().min(2).max(500),
    }),
  );

  const RefundResult = registry.register(
    'RefundResult',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string(),
      orderId: z.string().uuid(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const RefundEnvelope = registry.register(
    'RefundEnvelope',
    z.object({
      result: RefundResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/credit-adjustments',
    summary: 'Apply a signed admin credit adjustment (ADR 017).',
    description:
      "Writes a signed `credit_transactions` row (`type='adjustment'`) and atomically bumps `user_credits.balance_minor`. All five ADR-017 invariants enforced: actor from `requireAdmin`, `Idempotency-Key` header required, `reason` body field (2..500 chars), append-only ledger, Discord audit fanout AFTER commit. Response envelope is uniform across admin writes: `{ result, audit }`, where `audit.replayed: true` indicates a snapshot replay.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: CreditAdjustmentBody } },
      },
    },
    responses: {
      200: {
        description: 'Adjustment applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: CreditAdjustmentEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
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
      409: {
        description: 'Debit would drive the balance below zero (INSUFFICIENT_BALANCE)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description:
          'Rate limit exceeded (20/min per IP) or per-admin per-currency UTC-day adjustment cap hit (`DAILY_LIMIT_EXCEEDED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the adjustment',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // A2-901 — admin refund write. Same ADR-017 discipline as credit-
  // adjustments (actor from requireAdmin, Idempotency-Key header,
  // reason body field, append-only ledger, Discord audit) + DB-level
  // duplicate-refund rejection via the partial unique index on
  // (type, reference_type, reference_id) landed in migration 0013.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/refunds',
    summary: 'Issue a refund credit bound to an order (A2-901 + ADR 017).',
    description:
      "Writes a positive-amount `credit_transactions` row (`type='refund'`, `reference_type='order'`, `reference_id=<orderId>`) and atomically bumps `user_credits.balance_minor`. Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB partial unique index on (type, reference_type, reference_id) rejects a second refund row for the same order with 409 `REFUND_ALREADY_ISSUED`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: RefundBody } },
      },
    },
    responses: {
      200: {
        description: 'Refund applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: RefundEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId / orderId',
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
      409: {
        description: 'A refund has already been issued for this order (REFUND_ALREADY_ISSUED)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the refund',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — withdrawal write (ADR-024 / A2-901) ──────────────────────────
  //
  // Schemas (WithdrawalBody / Result / Envelope) + path registration
  // live in `./admin-withdrawal-write.ts`. Fanned out from here so
  // the three-write façade in `admin.ts` keeps registering the
  // entire admin-write surface with one factory call.
  registerAdminWithdrawalWriteOpenApi(registry, errorResponse, AdminWriteAudit);
}
