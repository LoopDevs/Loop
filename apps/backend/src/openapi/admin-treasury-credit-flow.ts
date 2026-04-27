/**
 * Admin treasury credit-flow OpenAPI registration
 * (ADR 009 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin-supplier-spend.ts`
 * so the ledger-flow time-series sits alongside its two
 * locally-scoped schemas, separate from the supplier-spend
 * snapshot + activity paths in the parent file:
 *
 *   - GET /api/admin/treasury/credit-flow
 *
 * The path completes the "treasury-velocity triplet" — supplier
 * spend (parent file) + supplier-spend activity (parent file) +
 * this credit-flow series — but the schemas here are
 * ledger-side (`credit_transactions` deltas) rather than
 * supplier-side (orders / wholesale).
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `AdminTreasuryCreditFlowDay`
 *   - `AdminTreasuryCreditFlowResponse`
 *
 * Re-invoked from `registerAdminSupplierSpendOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/treasury/credit-flow` plus its two
 * locally-scoped schemas on the supplied registry.
 */
export function registerAdminTreasuryCreditFlowOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminTreasuryCreditFlowDay = registry.register(
    'AdminTreasuryCreditFlowDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      currency: z.string().length(3),
      creditedMinor: z.string(),
      debitedMinor: z.string(),
      netMinor: z.string(),
    }),
  );

  const AdminTreasuryCreditFlowResponse = registry.register(
    'AdminTreasuryCreditFlowResponse',
    z.object({
      windowDays: z.number().int().min(1).max(180),
      currency: z.enum(['USD', 'GBP', 'EUR']).nullable(),
      days: z.array(AdminTreasuryCreditFlowDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury/credit-flow',
    summary: 'Per-day credited/debited/net ledger flow (ADR 009 / 015).',
    description:
      "Per-day × per-currency ledger delta from `credit_transactions`. Answers the treasury question the snapshot can't: 'are we generating liability faster than we settle it?'. A week of net > 0 days means cashback issuance is outpacing user settlement — treasury plans Stellar-side funding ahead of the curve. Credited = sum(amount_minor) for positive-amount types (cashback, interest, refund) + positive adjustments; debited = abs(sum) for negative-amount types (spend, withdrawal). bigint-as-string. `?currency` zero-fills; default 30d, cap 180d.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day credit-flow rows',
        content: { 'application/json': { schema: AdminTreasuryCreditFlowResponse } },
      },
      400: {
        description: 'Unknown `currency`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
