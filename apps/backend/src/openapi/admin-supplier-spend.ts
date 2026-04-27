/**
 * Admin supplier-spend & treasury credit-flow OpenAPI registrations
 * (ADR 009 / 013 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Three paths
 * that read together as the "treasury-velocity triplet" — supplier
 * spend (CTX wholesale), supplier-spend activity (per-day series),
 * and treasury credit-flow (ledger in/out) — all per-currency,
 * all `bigint`-as-string, all driving the /admin/cashback dashboard.
 *
 * Paths in the slice:
 *   - GET /api/admin/supplier-spend
 *   - GET /api/admin/supplier-spend/activity
 *   - GET /api/admin/treasury/credit-flow
 *
 * Locally-scoped schemas travel with the slice:
 *   - `AdminSupplierSpendResponse`
 *   - `AdminSupplierSpendActivityDay` / `Response`
 *   - `AdminTreasuryCreditFlowDay` / `Response`
 *
 * `AdminSupplierSpendRow` stays in admin.ts because it is shared
 * across slice boundaries (also referenced by the per-operator
 * supplier-spend response in `./admin-operator-fleet.ts`). It is
 * threaded into both slices as a parameter so each side keeps the
 * same registered schema instance — same pattern as the
 * `adminWriteAudit` threading in #1166 and `adminSupplierSpendRow`
 * threading in #1172.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminTreasuryCreditFlowOpenApi } from './admin-treasury-credit-flow.js';

/**
 * Registers the supplier-spend / treasury credit-flow paths +
 * their locally-scoped schemas on the supplied registry. Called
 * once from `registerAdminOpenApi`.
 */
export function registerAdminSupplierSpendOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminSupplierSpendRow: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local alias keeps the body syntactically identical to the
  // pre-decomposition source.
  const AdminSupplierSpendRow = adminSupplierSpendRow;

  // ─── Admin — supplier spend (ADR 013 / 015) ────────────────────────────────
  // (Row schema lives in admin.ts; only the response wrapper here.)

  const AdminSupplierSpendResponse = registry.register(
    'AdminSupplierSpendResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminSupplierSpendRow),
    }),
  );

  // ─── Admin — supplier-spend activity (ADR 013 / 015) ───────────────────────

  const AdminSupplierSpendActivityDay = registry.register(
    'AdminSupplierSpendActivityDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      currency: z.string().length(3),
      count: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
    }),
  );

  const AdminSupplierSpendActivityResponse = registry.register(
    'AdminSupplierSpendActivityResponse',
    z.object({
      windowDays: z.number().int().min(1).max(180),
      currency: z.enum(['USD', 'GBP', 'EUR']).nullable(),
      days: z.array(AdminSupplierSpendActivityDay),
    }),
  );

  // The treasury credit-flow path
  // (`/api/admin/treasury/credit-flow`) plus its two
  // locally-scoped schemas (`AdminTreasuryCreditFlowDay`,
  // `AdminTreasuryCreditFlowResponse`) live in
  // `./admin-treasury-credit-flow.ts`. Registered after the two
  // supplier-spend paths below so OpenAPI path-registration order
  // is preserved.

  registry.registerPath({
    method: 'get',
    path: '/api/admin/supplier-spend',
    summary: 'Per-currency supplier-spend snapshot (ADR 013 / 015).',
    description:
      'Aggregates fulfilled orders in the window by catalog currency. Each row exposes count, total face value, wholesale cost billed by CTX, user cashback, and loop margin retained — all `bigint`-minor as strings. Default window is the last 24h; pass `?since=<iso-8601>` to walk back. Capped at 366 days to keep the postgres aggregate cheap.',
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
        description: 'Per-currency supplier-spend rows',
        content: { 'application/json': { schema: AdminSupplierSpendResponse } },
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
    path: '/api/admin/supplier-spend/activity',
    summary: 'Per-day per-currency supplier-spend time-series (ADR 013 / 015).',
    description:
      "Time-axis of `/api/admin/supplier-spend`: per-day aggregate of face/wholesale/cashback/margin for fulfilled orders bucketed by `fulfilled_at::date` (UTC). `?currency=USD|GBP|EUR` zero-fills days via LEFT JOIN; without the filter, only (day, currency) pairs with activity appear. Pairs with `/api/admin/treasury/credit-flow` (ledger in) and `/api/admin/payouts-activity` (chain settle out) as the 'treasury-velocity triplet' ops watches to know money moved as expected today.",
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
        description: 'Per-day per-currency rows',
        content: { 'application/json': { schema: AdminSupplierSpendActivityResponse } },
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

  // The treasury credit-flow path lives in
  // `./admin-treasury-credit-flow.ts` along with its two
  // locally-scoped schemas. Same path-registration position as
  // the original block.
  registerAdminTreasuryCreditFlowOpenApi(registry, errorResponse);
}
