/**
 * Admin per-operator drill OpenAPI registrations
 * (ADR 013 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin-operator-fleet.ts`
 * so the two `/api/admin/operators/{operatorId}/*` drills sit
 * alongside their three locally-scoped schemas, separate from the
 * fleet-aggregate paths in the parent file:
 *
 *   - GET /api/admin/operators/{operatorId}/supplier-spend
 *   - GET /api/admin/operators/{operatorId}/activity
 *
 * Both paths are the per-operator axis (ADR-022 quartet pattern)
 * of the fleet-wide `/operator-stats` and `/supplier-spend`
 * surfaces — they answer "how is op-X doing" rather than "which
 * operator is the slowest / busiest in the fleet".
 *
 * Locally-scoped schemas (none referenced anywhere else):
 *   - `AdminOperatorSupplierSpendResponse`
 *   - `AdminOperatorActivityDay` / `AdminOperatorActivityResponse`
 *
 * `adminSupplierSpendRow` is registered upstream in admin.ts and
 * shared with the fleet supplier-spend section; threaded in as a
 * parameter so both consumers keep the same registered component
 * instance.
 *
 * Re-invoked from `registerAdminOperatorFleetOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the per-operator drill paths + their three locally-
 * scoped schemas on the supplied registry. Called once from
 * `registerAdminOperatorFleetOpenApi`.
 */
export function registerAdminOperatorFleetPerOperatorOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminSupplierSpendRow: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminSupplierSpendRow = adminSupplierSpendRow;

  // ─── Admin — per-operator supplier spend (ADR 013 / 015 / 022) ─────────────

  const AdminOperatorSupplierSpendResponse = registry.register(
    'AdminOperatorSupplierSpendResponse',
    z.object({
      operatorId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminSupplierSpendRow),
    }),
  );

  // ─── Admin — per-operator activity (ADR 013 / 022) ─────────────────────────

  const AdminOperatorActivityDay = registry.register(
    'AdminOperatorActivityDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      created: z.number().int().min(0),
      fulfilled: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  );

  const AdminOperatorActivityResponse = registry.register(
    'AdminOperatorActivityResponse',
    z.object({
      operatorId: z.string(),
      windowDays: z.number().int().min(1).max(90),
      days: z.array(AdminOperatorActivityDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/supplier-spend',
    summary: 'Per-operator supplier-spend by currency (ADR 013 / 015 / 022).',
    description:
      "Per-currency aggregate of what Loop paid CTX for fulfilled orders carried by one specific operator. ADR-022 per-operator axis of the fleet `/api/admin/supplier-spend` — that says 'total across operators', this says 'how much did op-X drive'. Same per-currency row shape (bigint-as-string money). Zero-volume operators return 200 with `rows: []`. Default window 24h, capped 366d.",
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
          .openapi({ description: 'ISO-8601 — lower bound on fulfilledAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-currency supplier-spend rows for the operator',
        content: { 'application/json': { schema: AdminOperatorSupplierSpendResponse } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/activity',
    summary: 'Per-operator daily activity time-series (ADR 013 / 022).',
    description:
      'Per-day created / fulfilled / failed order counts for one operator over the last N calendar days (default 7, cap 90, UTC-bucketed). Zero-filled by the backend (`LEFT JOIN generate_series`) so the layout is stable even when the operator is idle. A rising `failed` line or a dropping `fulfilled / created` ratio is a scheduler-tuning / CTX-escalation signal before the circuit breaker trips.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        operatorId: z.string().min(1).max(128),
      }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day activity series',
        content: { 'application/json': { schema: AdminOperatorActivityResponse } },
      },
      400: {
        description: 'Malformed `operatorId`',
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
        description: 'Internal error loading activity',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
