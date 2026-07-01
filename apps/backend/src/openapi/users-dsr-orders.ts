/**
 * User DSR + orders-summary OpenAPI registrations
 * (ADR 009 / 010 / 015 / GDPR DSR articles 17 + 20).
 *
 * Lifted out of `apps/backend/src/openapi/users.ts`. Three caller-
 * scoped paths that don\'t fit the cashback / pending-payouts /
 * profile clusters and travel naturally as a small "tail":
 *
 *   - POST /api/users/me/dsr/delete    (A2-1905, GDPR right of erasure)
 *   - GET  /api/users/me/dsr/export    (A2-1906, GDPR right of portability)
 *   - GET  /api/users/me/orders/summary (lifetime + month-to-date order counters)
 *
 * No locally-scoped registered schemas — the three paths use
 * inline `z.object` literals for their response bodies (matches
 * the original users.ts behaviour). Only `errorResponse` crosses
 * the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the user DSR + orders-summary paths on the supplied
 * registry. Called once from `registerUsersOpenApi`.
 */
export function registerUsersDsrOrdersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'post',
    path: '/api/users/me/dsr/delete',
    summary: 'A2-1905: self-serve account deletion (DSR / GDPR right of erasure).',
    description:
      "Anonymises the calling user — email replaced with a synthetic placeholder, OAuth identity links deleted, refresh tokens revoked. Ledger rows (`credit_transactions` / `orders` / `pending_payouts`) are RETAINED for tax / regulatory compliance per ADR 009 (append-only) but no longer link to a real person. Refuses with 409 + a typed `code` (`PENDING_PAYOUTS`, `IN_FLIGHT_ORDERS`, `FAILED_UNCOMPENSATED_WITHDRAWALS`, or `BALANCE_NOT_ZERO`) when there's money / fulfilment in flight, a failed withdrawal awaiting compensation, or an unredeemed cashback balance (PLAT-30-03 — a never-linked-wallet user can hold a bare `user_credits` balance with none of the other three preconditions ever tripping) — see `apps/backend/src/users/dsr-delete.ts` module header for the full posture.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Account anonymised — caller session is invalidated',
        content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'Pre-condition failed: pending payout, in-flight order, failed withdrawal awaiting compensation (A4-078), or a non-zero cashback balance (PLAT-30-03)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (3/hour per IP — destructive)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error during anonymisation',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/dsr/export',
    summary: 'A2-1906: self-serve data export (DSR / GDPR portability).',
    description:
      "Returns every database row Loop holds keyed to the calling user — `users` row, `user_identities`, `user_credits`, `credit_transactions`, `orders`, `pending_payouts`. Versioned schema envelope (`schemaVersion: 1`). Gift card redeem codes / PINs are deliberately excluded — `redeemIssued: boolean` reports whether one was issued, the secret material stays in the in-app order view. Off-host data sources (CTX gift card detail, backend access logs, Sentry events, Discord audit) require a `privacy@loopfinance.io` request — listed in the response's `notes.excluded`. `Content-Disposition: attachment` so the browser saves the JSON directly.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Data export envelope',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row no longer exists (rare — race with hard delete)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (5/hour per IP — non-trivial multi-table scan)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/orders/summary',
    summary: "Compact 5-number summary of the caller's orders (ADR 010 / 015).",
    description:
      "Single query with FILTER-ed COUNT + SUM so the /orders page header renders without hitting the list endpoint. `pendingCount` groups `pending_payment` + `paid` + `procuring` — all 'in flight' from the user's perspective. `failedCount` groups `failed` + `expired`. `totalSpentMinor` is `SUM(charge_minor)` over `state = 'fulfilled'` only so pending / failed orders don't inflate lifetime spend. Home-currency locked — cross-currency detail stays admin-only.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '5-number summary',
        content: {
          'application/json': {
            schema: z.object({
              currency: z.string().length(3),
              totalOrders: z.number().int().min(0),
              fulfilledCount: z.number().int().min(0),
              pendingCount: z.number().int().min(0),
              failedCount: z.number().int().min(0),
              totalSpentMinor: z.string(),
            }),
          },
        },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the summary',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
