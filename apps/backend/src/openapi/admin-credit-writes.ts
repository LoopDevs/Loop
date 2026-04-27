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
 * Paths in the slice:
 *   - POST /api/admin/users/{userId}/credit-adjustments
 *   - POST /api/admin/users/{userId}/refunds                (A2-901)
 *   - POST /api/admin/users/{userId}/withdrawals            (ADR-024)
 *
 * Nine locally-scoped schemas travel with the slice:
 *
 *   - CreditAdjustmentBody / Result / Envelope
 *   - RefundBody / Result / Envelope
 *   - WithdrawalBody / Result / Envelope
 *
 * `AdminWriteAudit` stays in admin.ts because it is shared with
 * the cashback-config slice (#1166). Threaded into both slices as
 * a parameter so each side keeps the same registered schema
 * instance — the third consumer joins the same threading pattern
 * already established for `adminSupplierSpendRow` (#1172/#1173).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

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

  // ─── Admin — withdrawal write (ADR-024 / A2-901) ──────────────────────────

  const WithdrawalBody = registry.register(
    'WithdrawalBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Positive integer-as-string. 1..10_000_000 minor units. Same cap as refund/adjustment.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      destinationAddress: z.string().openapi({
        description: 'User Stellar wallet — `G` + 55 base32 chars.',
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const WithdrawalResult = registry.register(
    'WithdrawalResult',
    z.object({
      id: z
        .string()
        .uuid()
        .openapi({ description: 'credit_transactions.id of the new ledger row.' }),
      payoutId: z
        .string()
        .uuid()
        .openapi({ description: 'pending_payouts.id of the queued on-chain payout.' }),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'Unsigned magnitude. The stored credit-tx row is negative.',
      }),
      destinationAddress: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const WithdrawalEnvelope = registry.register(
    'WithdrawalEnvelope',
    z.object({
      result: WithdrawalResult,
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
        description: 'Rate limit exceeded (20/min per IP)',
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

  // A2-901 / ADR-024 — admin withdrawal write. Same ADR-017
  // discipline as refund (Idempotency-Key, audit envelope, Discord
  // notify). Atomic two-row write debits user_credits + queues a
  // LOOP-asset pending_payouts row. The partial unique index on
  // (type, reference_type, reference_id) extended in migration 0022
  // rejects a duplicate withdrawal credit-tx for the same payout id
  // with 409 WITHDRAWAL_ALREADY_ISSUED.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/withdrawals',
    summary:
      'Issue a withdrawal — debit cashback balance + queue on-chain payout (A2-901 / ADR-024).',
    description:
      "Writes a negative-amount `credit_transactions` row (`type='withdrawal'`, `reference_type='payout'`, `reference_id=<pending_payouts.id>`), atomically decrements `user_credits.balance_minor`, and queues a LOOP-asset payout row for the on-chain submit worker. Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB partial unique index on (type, reference_type, reference_id) — extended to include 'withdrawal' in migration 0022 — rejects a second credit-tx for the same payout id with 409 `WITHDRAWAL_ALREADY_ISSUED`. Phase 2a is admin-mediated only; user-initiated cash-out is deferred to Phase 2b.",
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
        content: { 'application/json': { schema: WithdrawalBody } },
      },
    },
    responses: {
      200: {
        description: 'Withdrawal applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: WithdrawalEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid body, non-uuid userId, or insufficient balance (`INSUFFICIENT_BALANCE`)',
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
        description: 'Target user not found (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'A withdrawal credit-tx already references this payout id (`WITHDRAWAL_ALREADY_ISSUED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the withdrawal',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'LOOP issuer for the requested currency not configured in env (`NOT_CONFIGURED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
