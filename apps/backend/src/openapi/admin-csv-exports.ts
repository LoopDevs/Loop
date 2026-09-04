/**
 * Admin CSV-export OpenAPI registrations (ADR 018 Tier-3).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. CSV-export routes form a self-contained
 * group — they all share:
 *
 *   - Content-type `text/csv; charset=utf-8` (no JSON schema; the
 *     body is raw CSV text, so the response schema is just
 *     `z.string()`).
 *   - 10/min per-IP rate limit (Tier-3 finance pull).
 *   - 10 000-row cap with `__TRUNCATED__` sentinel; RFC 4180
 *     formatting; `Cache-Control: private, no-store`.
 *
 * They depend only on the shared `errorResponse` schema (passed in
 * from `openapi.ts` via `admin.ts`); no admin-local schemas leak
 * across the boundary, which is what makes this slice self-contained
 * unlike the JSON-response sections that share dozens of inline
 * `z.object` definitions further up admin.ts.
 *
 * The bottom-of-file `/api/admin/treasury.csv` declares 401/403
 * responses because the matching handler wraps the CSV emission
 * with the usual `requireAuth` + `requireAdmin` chain — the other
 * CSV handlers fall through the same chain but the original openapi
 * registrations only declared 429 + 500, so we preserve that
 * verbatim rather than retrofit (a later parity-pass on admin
 * 401/403 documentation can sweep them all together).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminCsvExportsCashbackOpenApi } from './admin-csv-exports-cashback.js';
import { registerAdminCsvExportsRawRowsOpenApi } from './admin-csv-exports-raw-rows.js';
import { registerAdminCsvExportsTreasuryOpenApi } from './admin-csv-exports-treasury.js';

/**
 * Registers all `/api/admin/*.csv` paths on the supplied registry.
 * Called once from `registerAdminOpenApi`.
 */
export function registerAdminCsvExportsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin CSV exports (ADR 018 Tier-3) ─────────────────────────────────────
  //
  // Content-type text/csv; charset=utf-8 — no JSON schema because the body
  // is raw CSV text. Generated clients learn the endpoint exists + query
  // params + error shapes. ADR 018 conventions: RFC 4180, 10k-row cap with
  // __TRUNCATED__ sentinel, 10/min rate, Cache-Control: private, no-store.

  // The two cashback time-series CSVs
  // (`/api/admin/cashback-realization/daily.csv` and
  // `/api/admin/cashback-activity.csv`) live in
  // `./admin-csv-exports-cashback.ts`. Same path-registration
  // position as the original block.
  registerAdminCsvExportsCashbackOpenApi(registry, errorResponse);

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-activity.csv',
    summary:
      'Daily confirmed-payout CSV — settlement counterpart to cashback-activity.csv (ADR 015/016/018).',
    description:
      'Tier-3 CSV of /api/admin/payouts-activity. Columns: day,asset_code,payout_count,stroops. Zero days emit day,,0,0. Bucketed on confirmed_at::date. Window: ?days (default 31, cap 366).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants-catalog.csv',
    summary: 'Full merchant catalog + cashback-config state as CSV (ADR 011/018).',
    description:
      'Tier-3 CSV of the in-memory catalog joined against merchant_cashback_configs. Columns: merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at. Merchants without a config emit empty config columns ("no config yet" — distinct from active=false). Catalog is source of truth; evicted merchants drop out.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  // The two treasury CSVs (`/api/admin/treasury/credit-flow.csv`
  // and `/api/admin/treasury.csv`) live in
  // `./admin-csv-exports-treasury.ts`. Both fund the SOC-2 /
  // audit-evidence story — the daily series plus the point-in-
  // time snapshot diff cleanly in audit tooling. Same path-
  // registration position as the original block.
  registerAdminCsvExportsTreasuryOpenApi(registry, errorResponse);

  // ─── Three CSV exports lifted from the treasury+payouts block ───────────────
  //
  // Originally landed inline in the legacy openapi treasury+payouts
  // section rather than the dedicated CSV-export header below — they
  // are conceptually identical Tier-3 finance pulls (text/csv body,
  // 10/min rate limit, 366-day window cap, 10 000-row __TRUNCATED__
  // sentinel). Co-locating them here keeps every admin CSV registration
  // in one file so the 'where do CSV exports live?' answer is the same
  // for every reader.

  // The three "raw row dump" exports — `/api/admin/payouts.csv`,
  // `/api/admin/audit-tail.csv`, `/api/admin/orders.csv` — share the
  // same `?since` window + RFC 4180 + 6-status-code shape. They live
  // in `./admin-csv-exports-raw-rows.ts` separately from the
  // activity-rolling aggregate exports above.
  registerAdminCsvExportsRawRowsOpenApi(registry, errorResponse);
}
