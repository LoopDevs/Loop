/**
 * Admin operator-mix matrix OpenAPI registrations
 * (ADR 013 / 022 / 023).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. The three
 * "X × operator mix" endpoints implement ADR-023 mix-axis matrix
 * pattern — every metric in the fleet/per-merchant/per-user/self
 * quartet has a matching X × operator slice so incident triage
 * can pivot from "which merchant is slow?" → "which operator is
 * carrying that merchant?" → "what other merchants does that
 * operator carry?".
 *
 * Two paths registered directly here (the merchant-side pair
 * — same data viewed from each side of the merchant ↔ operator
 * relationship):
 *   - GET /api/admin/merchants/{merchantId}/operator-mix
 *   - GET /api/admin/operators/{operatorId}/merchant-mix
 *
 * Path delegated to a sibling slice:
 *   - GET /api/admin/users/{userId}/operator-mix —
 *     `./admin-user-operator-mix.ts` (owns
 *     `AdminUserOperatorMixRow` + `Response`)
 *
 * Schemas registered directly here:
 *
 *   - AdminMerchantOperatorMixRow / Response
 *   - AdminOperatorMerchantMixRow / Response
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminUserOperatorMixOpenApi } from './admin-user-operator-mix.js';

/**
 * Registers the operator-mix matrix paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminOperatorMixOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — merchant × operator mix (ADR 013 / 022) ───────────────────────

  const AdminMerchantOperatorMixRow = registry.register(
    'AdminMerchantOperatorMixRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminMerchantOperatorMixResponse = registry.register(
    'AdminMerchantOperatorMixResponse',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminMerchantOperatorMixRow),
    }),
  );

  // ─── Admin — operator × merchant mix (ADR 013 / 022) ───────────────────────

  const AdminOperatorMerchantMixRow = registry.register(
    'AdminOperatorMerchantMixRow',
    z.object({
      merchantId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminOperatorMerchantMixResponse = registry.register(
    'AdminOperatorMerchantMixResponse',
    z.object({
      operatorId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminOperatorMerchantMixRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/operator-mix',
    summary: 'Per-merchant × per-operator attribution (ADR 013 / 022).',
    description:
      "For one merchant, aggregate orders by `ctx_operator_id`. Exposes the merchant × operator axis currently not surfaced by `/operator-stats` (fleet, any merchant) or `/merchant-stats` (fleet, any operator). Answers the incident-triage question: 'merchant X is slow right now — which operator is primarily carrying them?'. Zero-attribution merchants return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        merchantId: z.string().min(1).max(128),
      }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-operator rows scoped to the merchant',
        content: { 'application/json': { schema: AdminMerchantOperatorMixResponse } },
      },
      400: {
        description: 'Malformed `merchantId` or `since`',
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/merchant-mix',
    summary: 'Per-operator × per-merchant attribution (ADR 013 / 022).',
    description:
      'Dual of `/api/admin/merchants/{merchantId}/operator-mix` — aggregates orders by `merchant_id` for one operator. Closes the operator × merchant matrix in both directions: incident-triage lands on the /merchants side ("which operator is carrying this problematic merchant?"); capacity-reviews land here ("which merchants is this operator carrying — concentration-risk or SLA lever?"). Zero-mix operators return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated. Default window 24h, capped 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        operatorId: z.string().min(1).max(128),
      }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rows scoped to the operator',
        content: { 'application/json': { schema: AdminOperatorMerchantMixResponse } },
      },
      400: {
        description: 'Malformed `operatorId` or `since`',
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — user × operator mix (ADR 013 / 022) ───────────────────────────
  //
  // Path + locally-scoped schemas (`AdminUserOperatorMixRow`,
  // `AdminUserOperatorMixResponse`) live in
  // `./admin-user-operator-mix.ts`. Fanned out from here so the
  // mix-axis registration in `admin.ts` keeps producing one factory
  // call for the entire matrix.
  registerAdminUserOperatorMixOpenApi(registry, errorResponse);
}
