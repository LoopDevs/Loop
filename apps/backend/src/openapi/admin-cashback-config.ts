/**
 * Admin cashback-config CRUD OpenAPI registrations (ADR 011 / 017).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. This slice owns the read surface
 * directly (list / CSV / fleet history) and fans the upsert + the
 * per-merchant history out to topical siblings:
 *
 *   - `AdminCashbackConfig` + `AdminCashbackConfigListResponse`
 *     declared here; `AdminCashbackConfig` is threaded into the
 *     upsert sibling so the envelope embeds the same registered
 *     shape.
 *   - The list / CSV / fleet-history paths registered directly.
 *   - The per-merchant upsert (`UpsertCashbackConfigBody` +
 *     `AdminCashbackConfigEnvelope`) lives in
 *     `./admin-cashback-config-upsert.ts`.
 *   - The per-merchant history (`AdminCashbackConfigHistoryRow` +
 *     `AdminCashbackConfigHistoryResponse`) lives in
 *     `./admin-cashback-config-history.ts`.
 *
 * The CRUD façade is preserved: callers in `admin.ts` still pass
 * the same threaded deps in one factory call and the spec output
 * stays byte-identical. Three dependencies cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts).
 *   - `cashbackPctString` (cross-section schema for the
 *     `numeric(5,2)`-as-string percentage shape — also used by
 *     Merchants).
 *   - `adminWriteAudit` (the ADR-017 audit envelope shape —
 *     defined upstream in admin.ts and reused by the credit-
 *     adjustment / withdrawal / refund envelopes).
 *
 * Threading those three through the slice's signature keeps the
 * spec output byte-identical: the call site still passes the same
 * shared instances, so generated `components.schemas` entries
 * point at the same registered schema objects.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminCashbackConfigHistoryOpenApi } from './admin-cashback-config-history.js';
import { registerAdminCashbackConfigUpsertOpenApi } from './admin-cashback-config-upsert.js';

/**
 * Registers the cashback-config schemas + the five
 * `/api/admin/merchant-cashback-configs*` paths on the supplied
 * registry. Called once from `registerAdminOpenApi`.
 */
export function registerAdminCashbackConfigOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  cashbackPctString: z.ZodTypeAny,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local aliases preserve the PascalCase identifiers the section
  // body used pre-decomposition. Keeping them aliased rather than
  // inlined means every schema reference inside the body remains
  // syntactically identical to the pre-slice source.
  const CashbackPctString = cashbackPctString;
  const AdminWriteAudit = adminWriteAudit;

  // ─── Admin — cashback-config (ADR 011) ──────────────────────────────────────
  //
  // Percentages are stored as `numeric(5,2)` and round-trip as strings
  // through postgres-js (`"80.00"`). The schema mirrors that wire shape
  // so clients don't silently coerce to JS numbers and drift.

  const AdminCashbackConfig = registry.register(
    'AdminCashbackConfig',
    z.object({
      merchantId: z.string(),
      wholesalePct: CashbackPctString,
      userCashbackPct: CashbackPctString,
      loopMarginPct: CashbackPctString,
      active: z.boolean(),
      updatedBy: z.string().openapi({
        description: 'Admin user id that performed the most recent upsert.',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const AdminCashbackConfigListResponse = registry.register(
    'AdminCashbackConfigListResponse',
    z.object({ configs: z.array(AdminCashbackConfig) }),
  );

  // The upsert path (PUT /api/admin/merchant-cashback-configs/{id})
  // and its two locally-scoped schemas (`UpsertCashbackConfigBody`
  // + `AdminCashbackConfigEnvelope`) live in
  // `./admin-cashback-config-upsert.ts`. Fanned out below the read
  // paths so OpenAPI path-registration order matches the
  // pre-decomposition source.

  // `AdminCashbackConfigHistoryRow` and
  // `AdminCashbackConfigHistoryResponse`, plus the per-merchant
  // history path that uses them, live in
  // `./admin-cashback-config-history.ts`. Registered at the bottom
  // of this factory so OpenAPI path-registration order is preserved.

  // ─── Admin — cashback-config CRUD (ADR 011) ─────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs',
    summary: 'List every merchant cashback-split config (ADR 011).',
    description:
      'Returns one row per configured merchant with the three split percentages + active flag + last-updated-by. Rows are ordered by merchantId so the admin UI renders a stable list across reloads.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Cashback configs',
        content: { 'application/json': { schema: AdminCashbackConfigListResponse } },
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
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs.csv',
    summary: 'CSV export of merchant cashback-split configs (ADR 011 / 018).',
    description:
      "Tier-3 bulk export per ADR 018 — finance / audit consumes the snapshot in a spreadsheet. Columns: merchant_id, merchant_name, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by, updated_at. Merchant-name falls back to merchant_id for rows whose merchant has evicted from the catalog (ADR 021 Rule A). Active serialises as the literal 'true' / 'false' so spreadsheet filters don't fight blanks. RFC 4180 (CRLF + quote-escape). Row cap 10 000 with a trailing `__TRUNCATED__` row on overflow — practically unreachable here (~hundreds of configs) but kept uniform with the other admin CSVs. 10/min rate limit.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV snapshot of all cashback-config rows',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              example:
                'merchant_id,merchant_name,wholesale_pct,user_cashback_pct,loop_margin_pct,active,updated_by,updated_at\r\namazon,Amazon,70.00,25.00,5.00,true,admin-abc,2026-04-22T14:00:00.000Z\r\n',
            }),
          },
        },
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the CSV',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs/history',
    summary: 'Fleet-wide cashback-config history feed (ADR 011 / 018).',
    description:
      "Newest-first view of every cashback-config edit across every merchant — the 'recent config changes' strip on the admin dashboard. Complement to the per-merchant drill (`/:merchantId/history`); this one doesn't require picking a merchant first. Merchant names enrich from the catalog and fall back to `merchantId` for evicted rows (ADR 021 Rule A). `?limit=` defaults 50, clamped [1, 200].",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Newest-first audit rows across all merchants',
        content: {
          'application/json': {
            schema: z.object({
              history: z.array(
                z.object({
                  id: z.string().uuid(),
                  merchantId: z.string(),
                  merchantName: z.string(),
                  wholesalePct: z.string(),
                  userCashbackPct: z.string(),
                  loopMarginPct: z.string(),
                  active: z.boolean(),
                  changedBy: z.string(),
                  changedAt: z.string().datetime(),
                }),
              ),
            }),
          },
        },
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
        description: 'Internal error reading history',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ADR-017 upsert (the only write in this CRUD surface) lives in
  // `./admin-cashback-config-upsert.ts`. Threaded with
  // `errorResponse + AdminCashbackConfig + AdminWriteAudit` so the
  // envelope still embeds the same registered `AdminCashbackConfig`
  // shape the read paths above declare.
  registerAdminCashbackConfigUpsertOpenApi(
    registry,
    errorResponse,
    AdminCashbackConfig,
    AdminWriteAudit,
  );

  // The trailing per-merchant history path lives in
  // `./admin-cashback-config-history.ts` along with its two
  // locally-scoped schemas. Same path-registration position as the
  // original block.
  registerAdminCashbackConfigHistoryOpenApi(registry, errorResponse, CashbackPctString);
}
