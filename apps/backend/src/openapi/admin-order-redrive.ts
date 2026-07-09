/**
 * Admin order re-drive OpenAPI registration (A5-1).
 *
 * Lifted out of `apps/backend/src/openapi/admin-order-cluster.ts` so
 * the one write path sits in its own file with its ADR-017/028-shaped
 * body / headers / envelope schemas, same split as
 * `admin-payouts-cluster-writes.ts` alongside its read-only sibling.
 *
 * Re-invoked from `registerAdminOrderClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `POST /api/admin/orders/{orderId}/redrive` plus its
 * locally-scoped body / result / envelope schemas on the supplied
 * registry.
 */
export function registerAdminOrderRedriveOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const OrderRedriveBody = registry.register(
    'OrderRedriveBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const OrderRedriveResult = registry.register(
    'AdminOrderRedriveResult',
    z.object({
      orderId: z.string().uuid(),
      outcome: z.enum(['fulfilled', 'failed', 'skipped']).openapi({
        description: 'What procureOne reported for this attempt.',
      }),
      state: z.string().openapi({
        description:
          'Order state re-read fresh from the DB after the attempt — not inferred from `outcome`.',
      }),
    }),
  );

  const OrderRedriveEnvelope = registry.register(
    'AdminOrderRedriveEnvelope',
    z.object({ result: OrderRedriveResult, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/orders/{orderId}/redrive',
    summary: 'Re-drive a stuck paid/procuring order (A5-1 — the order re-drive lever).',
    description:
      "Re-runs the SAME procurement path the worker itself uses (`procureOne`) for a `paid` or `procuring` order — the operator lever for a stuck order that has no other UI action today. `paid` orders redrive directly (the `markOrderProcuring` state-CAS makes this safe even if a live worker is racing it). `procuring` orders only redrive once they're past the same 15-minute staleness bar the automatic stuck-procurement sweep uses (`ORDER_REDRIVE_NOT_STALE` otherwise — a live worker may still be mid-flight) AND only when Loop has NOT already paid CTX for the order per the durable `ctx_settlements` record (`ORDER_REDRIVE_CTX_ALREADY_PAID` otherwise — redriving would create a wasteful, confusing second CTX order; the `ctx_settlements` reconcile guard would refuse to pay it, so it can't double-pay, but there's no reason to walk into it). `fulfilled`/`failed`/`expired`/`pending_payment` orders are refused (`ORDER_NOT_REDRIVABLE`) — this endpoint is a retry lever only, not cancel-and-refund (that's the separate A5-4 item). Idempotent: the underlying `markOrderProcuring` CAS + `ctx_settlements` durable settlement record (hardening A4, INV-7) make a double-click or a concurrent redrive request converge to at most one procurement attempt and at most one CTX payment — never a double-procure or double-pay. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. ADR-028 step-up gate enforced at the route (`order-redrive` scope).",
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
        content: { 'application/json': { schema: OrderRedriveBody } },
      },
    },
    responses: {
      200: {
        description: 'Redrive applied (or replayed from snapshot)',
        content: { 'application/json': { schema: OrderRedriveEnvelope } },
      },
      400: {
        description:
          "Missing idempotency key, invalid reason, malformed orderId, or order is not in a redrivable state (`ORDER_NOT_REDRIVABLE` — only 'paid'/'procuring' orders qualify)",
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
          "Order not eligible for a redrive right now: still within the normal procurement window (`ORDER_REDRIVE_NOT_STALE`), Loop already paid CTX for this order (`ORDER_REDRIVE_CTX_ALREADY_PAID`), or the order's state changed mid-request (`ORDER_REDRIVE_STATE_CHANGED`)",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description:
          'Rate limit exceeded (10/min per IP — every call can be a CTX round-trip + redemption wait)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error redriving the order (`INTERNAL_ERROR`), or the stored replay snapshot for this Idempotency-Key is unreadable (`IDEMPOTENCY_SNAPSHOT_CORRUPT` — the write is never re-executed)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
