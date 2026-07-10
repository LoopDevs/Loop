/**
 * Admin order-bound refund OpenAPI registration (A5-4).
 *
 * Lifted out alongside `./admin-order-redrive.ts` — the one write path
 * sits in its own file with its ADR-017/028-shaped body / headers /
 * envelope schemas.
 *
 * Re-invoked from `registerAdminOrderClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `POST /api/admin/orders/{orderId}/refund` plus its
 * locally-scoped body / result / envelope schemas on the supplied
 * registry.
 */
export function registerAdminOrderRefundOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const OrderRefundAttestation = registry.register(
    'AdminOrderRefundAttestation',
    z.object({
      codeUnused: z.literal(true).openapi({
        description:
          'Must be exactly `true` — the operator affirms the delivered gift-card code is unused/unusable.',
      }),
      attestationNote: z.string().min(2).max(500),
    }),
  );

  const OrderRefundBody = registry.register(
    'OrderRefundBody',
    z.object({
      reason: z.string().min(2).max(500),
      attestation: OrderRefundAttestation.optional().openapi({
        description:
          "Required (and validated server-side) ONLY when the order is `fulfilled` — omitting it on a fulfilled order's refund attempt returns 400 `ORDER_REFUND_ATTESTATION_REQUIRED`.",
      }),
    }),
  );

  const OrderRefundResult = registry.register(
    'AdminOrderRefundResult',
    z.object({
      orderId: z.string().uuid(),
      paymentMethod: z.enum(['xlm', 'usdc', 'credit', 'loop_asset']),
      refundMethod: z.enum(['onchain_deposit_refund', 'mirror_credit']),
      amountMinor: z.string(),
      currency: z.string(),
      orderState: z.string().openapi({
        description:
          'Order state re-read fresh after the refund. `paid`/`procuring` orders are fenced to `failed` as part of the refund; `failed`/`fulfilled` orders keep their state — there is no `refunded` order state, the ledger record IS the refund.',
      }),
      attested: z.boolean().openapi({
        description:
          'True when this was a fulfilled-order refund gated on the code-unused attestation.',
      }),
      onChain: z
        .object({ txHash: z.string() })
        .nullable()
        .openapi({ description: "Set only for `paymentMethod IN ('xlm', 'usdc')`." }),
      mirrorCredit: z
        .object({ newBalanceMinor: z.string() })
        .nullable()
        .openapi({ description: "Set only for `paymentMethod = 'credit'`." }),
    }),
  );

  const OrderRefundEnvelope = registry.register(
    'AdminOrderRefundEnvelope',
    z.object({ result: OrderRefundResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/orders/{orderId}/refund',
    summary: 'Order-bound admin refund, incl. fulfilled-order-via-attestation (A5-4).',
    description:
      "Refunds a `paid` / `procuring` / `failed` order directly, or a `fulfilled` order behind a required code-unused attestation (the operator affirms the delivered gift-card code is unused/unusable — the accepted compensating control for the double-spend risk this endpoint deliberately accepts pending CTX redemption-verification; see `docs/threat-model.md`). Reuses the SAME primitives the existing auto-refund path uses, dispatched by `orders.paymentMethod`: `xlm`/`usdc` → on-chain refund-to-sender (the A6 `refundDeposit` machinery, via the order's stored payment snapshot); `credit` → mirror-credit refund (ADR 017); `loop_asset` → FAILS CLOSED (409 `ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD`, matching the existing R3-2 posture — escalate for a manual money-review refund). `paid`/`procuring` orders are fenced to `failed` (via `markOrderFailed`) as PART of the refund, before any money moves, so the procurement worker / A5-1 redrive lever can never later pay CTX for an order whose payment was just refunded; a `procuring` order carries two extra gates matching `sweepStuckProcurement`'s auto-refund safety — it must be stale (`procured_at` older than the 15-min recovery-sweep cutoff, closing the live-worker TOCTOU; a fresh procuring order is refused 400 `ORDER_NOT_REFUNDABLE`) AND Loop must NOT have already paid CTX (refused 409 `ORDER_REFUND_CTX_ALREADY_PAID`). INV-8 (single-issue-per-order) is enforced entirely by the underlying primitives (the migration-0013 partial unique index + the cross-order-row-lock check against the other refund exit) — a second refund attempt for the same order returns 409 `ORDER_ALREADY_REFUNDED`. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. ADR-028 step-up gate enforced at the route (`order-refund` scope).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
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
        content: { 'application/json': { schema: OrderRefundBody } },
      },
    },
    responses: {
      200: {
        description: 'Refund applied (or replayed from snapshot)',
        content: { 'application/json': { schema: OrderRefundEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid reason, malformed orderId, the order is `pending_payment`/`expired` or a not-yet-stale `procuring` order still actively procuring (`ORDER_NOT_REFUNDABLE`), or the order is `fulfilled` and no attestation was supplied (`ORDER_REFUND_ATTESTATION_REQUIRED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not staff (concealment), or no such order',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'The order already carries a refund (`ORDER_ALREADY_REFUNDED`), is `procuring` with CTX already paid (`ORDER_REFUND_CTX_ALREADY_PAID` — refunding now would double-lose money), the payment method is `loop_asset` (`ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD`), or the order state changed concurrently (`ORDER_NOT_REFUNDABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error refunding the order (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT` — the write is never re-executed)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description:
          'The on-chain refund-to-sender submit failed, or the order predates the payment-snapshot columns (pre-migration order — refund manually) (`ORDER_REFUND_SUBMIT_FAILED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
