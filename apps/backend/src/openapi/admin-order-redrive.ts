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
    summary: 'Re-drive a stuck paid order (A5-1 — the order re-drive lever).',
    description:
      "Re-runs the SAME procurement path the worker itself uses (`procureOne`) for a `paid` order the worker never drained — the operator lever for a paid order stranded by a downed worker (the automatic recovery sweep only touches `procuring` rows, so a stuck `paid` order otherwise sits forever). Safe under concurrency: `markOrderProcuring`'s `WHERE state='paid'` CAS is a hard single-flight gate — a live worker tick, the sweep, or a second concurrent redrive all contend on it and exactly one wins the transition into `procuring`; every other `procureOne` returns `'skipped'` before it ever reaches `payCtxOrder`, so a redrive can never produce a second in-flight procurement or a second CTX payment for the order (INV-7). Scope is `paid` only: a `procuring` order is refused with 409 `ORDER_REDRIVE_IN_PROGRESS` — force-re-procuring an in-flight order is a genuine double-pay / stranding risk (money-review 2026-07-09), and stuck `procuring` orders are auto-recovered by the recovery sweep. Terminal / pre-payment states are refused with 400 `ORDER_NOT_REDRIVABLE`. This is a retry lever only, not cancel-and-refund (that's the separate A5-4 item). ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. ADR-028 step-up gate enforced at the route (`order-redrive` scope).",
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
          'Missing idempotency key, invalid reason, malformed orderId, or the order is not `paid` (`ORDER_NOT_REDRIVABLE` — a terminal / pre-payment state)',
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
          'Order is currently `procuring` (`ORDER_REDRIVE_IN_PROGRESS`) — refused; stuck procuring orders are auto-recovered by the recovery sweep, and force-re-procuring is a double-pay / stranding risk',
        content: { 'application/json': { schema: errorResponse } },
      },
      422: {
        description:
          "NS-05: the order's face value exceeds the per-action value cap (`ADMIN_ACTION_VALUE_CAP_EXCEEDED`) — refused before any CTX payment; no money moved. Cap is `LOOP_ADMIN_ACTION_VALUE_CAP_MINOR` (default 100_000 minor = 1,000 units of the order currency).",
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
