/**
 * Admin user × operator mix OpenAPI registration (ADR 013 / 022).
 *
 * Lifted out of `./admin-operator-mix.ts`. Third corner of the
 * mix-axis triangle (alongside `/merchants/{id}/operator-mix` and
 * `/operators/{id}/merchant-mix`). Aggregates orders for one user
 * by `ctx_operator_id` — support pivots here during per-user
 * complaints: "user X's slow cashback → 80% of their orders went
 * through op-beta-02 which has a failing circuit".
 *
 * Pulling it out leaves the parent file focused on the merchant-
 * side axes (merchant × operator and the inverse operator ×
 * merchant) — the user-side axis lives alongside the rest of the
 * per-user drill territory naturally.
 *
 * Path in the slice:
 *   - GET /api/admin/users/{userId}/operator-mix
 *
 * Two locally-scoped schemas travel with it:
 *   - `AdminUserOperatorMixRow`
 *   - `AdminUserOperatorMixResponse`
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the user × operator mix path + its locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOperatorMixOpenApi`.
 */
export function registerAdminUserOperatorMixOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — user × operator mix (ADR 013 / 022) ───────────────────────────

  const AdminUserOperatorMixRow = registry.register(
    'AdminUserOperatorMixRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminUserOperatorMixResponse = registry.register(
    'AdminUserOperatorMixResponse',
    z.object({
      userId: z.string().uuid(),
      since: z.string().datetime(),
      rows: z.array(AdminUserOperatorMixRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/operator-mix',
    summary: 'Per-user × per-operator attribution for support triage (ADR 013 / 022).',
    description:
      'Third corner of the mix-axis triangle (alongside /merchants/{id}/operator-mix and /operators/{id}/merchant-mix). Aggregates orders for one user by ctx_operator_id. Support pivots here during per-user complaints: "user X\'s slow cashback → 80% of their orders went through op-beta-02 which has a failing circuit". Zero-mix users return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated. Default window 24h, cap 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
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
        description: 'Per-operator rows scoped to the user',
        content: { 'application/json': { schema: AdminUserOperatorMixResponse } },
      },
      400: {
        description: 'Malformed `userId` or `since`',
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
}
