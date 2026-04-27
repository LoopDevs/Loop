/**
 * Admin operator-fleet OpenAPI registrations
 * (ADR 013 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Four paths
 * that together back the /admin/operators dashboard page:
 *
 *   - GET /api/admin/operator-stats            (fleet stats)
 *   - GET /api/admin/operators/latency         (fleet latency)
 *   - GET /api/admin/operators/{id}/supplier-spend
 *   - GET /api/admin/operators/{id}/activity   (per-op timeseries)
 *
 * Five locally-scoped schemas travel with the slice (the four
 * `AdminOperator*` pairs plus `AdminOperatorActivityDay`):
 *
 *   - AdminOperatorStatsRow / Response
 *   - AdminOperatorLatencyRow / Response
 *   - AdminOperatorSupplierSpendResponse
 *   - AdminOperatorActivityDay / Response
 *
 * Two deps cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts)
 *   - `adminSupplierSpendRow` — `AdminOperatorSupplierSpendResponse`
 *     embeds the per-currency row shape declared upstream in the
 *     fleet supplier-spend section (`AdminSupplierSpendRow`).
 *     Threaded as a parameter so both sides keep the same
 *     registered schema instance.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the operator-fleet paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminOperatorFleetOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminSupplierSpendRow: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local alias preserves the PascalCase identifier the schema
  // body used pre-decomposition.
  const AdminSupplierSpendRow = adminSupplierSpendRow;

  // ─── Admin — operator stats (ADR 013) ──────────────────────────────────────

  const AdminOperatorStatsRow = registry.register(
    'AdminOperatorStatsRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminOperatorStatsResponse = registry.register(
    'AdminOperatorStatsResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminOperatorStatsRow),
    }),
  );

  // ─── Admin — operator latency (ADR 013 / 022) ──────────────────────────────

  const AdminOperatorLatencyRow = registry.register(
    'AdminOperatorLatencyRow',
    z.object({
      operatorId: z.string(),
      sampleCount: z.number().int().min(0),
      p50Ms: z.number().int().min(0),
      p95Ms: z.number().int().min(0),
      p99Ms: z.number().int().min(0),
      meanMs: z.number().int().min(0),
    }),
  );

  const AdminOperatorLatencyResponse = registry.register(
    'AdminOperatorLatencyResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminOperatorLatencyRow),
    }),
  );

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
    path: '/api/admin/operator-stats',
    summary: 'Per-operator order volume + success rate (ADR 013).',
    description:
      "Groups orders in the window by `ctx_operator_id`, skipping pre-procurement rows where the operator is still null. Each row carries the total order count, fulfilled count, failed count, and the most-recent createdAt attributed to that operator. Ordered by order_count descending so the top-traffic account surfaces first. Complements `/api/admin/supplier-spend` — that one answers 'what did we pay CTX', this one answers 'which operator actually did the work'. Default window 24h, capped at 366 days.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
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
        description: 'Per-operator stats rows',
        content: { 'application/json': { schema: AdminOperatorStatsResponse } },
      },
      400: {
        description: 'Invalid `since`',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/latency',
    summary: 'Per-operator fulfilment latency — p50/p95/p99 ms (ADR 013 / 022).',
    description:
      'Percentile fulfilment latency (`fulfilledAt - paidAt`, ms) per `ctx_operator_id` for fulfilled orders in the window. Complements `/api/admin/operator-stats` — stats says which operator is busy; this says which is slow. A busy operator with a rising p95 is the early signal before the circuit breaker trips. Only rows with both timestamps set + non-null operator are aggregated — mid-flight orders would poison the percentiles. Sorted by p95 descending so the slowest operator surfaces first. Default window 24h, capped 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
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
        description: 'Per-operator latency rows',
        content: { 'application/json': { schema: AdminOperatorLatencyResponse } },
      },
      400: {
        description: 'Invalid or out-of-window `since`',
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
