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
 * The bottom-of-file `/api/admin/treasury.csv` and
 * `/api/admin/operators-snapshot.csv` declare 401/403 responses
 * because the matching handlers wrap the CSV emission with the
 * usual `requireAuth` + `requireAdmin` chain — the other CSV
 * handlers fall through the same chain but the original openapi
 * registrations only declared 429 + 500, so we preserve that
 * verbatim rather than retrofit (a later parity-pass on admin
 * 401/403 documentation can sweep them all together).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization/daily.csv',
    summary: 'Daily cashback-realization trend CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-realization/daily. Columns: day,currency,earned_minor,spent_minor,recycled_bps. LEFT-JOIN null-currency rows are dropped pre-truncation so the row cap counts real signal. Window: ?days (default 31, cap 366). Row cap 10 000.',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-activity.csv',
    summary: 'Daily cashback accrual as RFC 4180 CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-activity. Columns: day,currency,cashback_count,cashback_minor. Zero-activity days emit day,,,0,0. Window: ?days (default 31, cap 366). Row cap 10 000.',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-activity.csv',
    summary: 'Per-merchant flywheel-activity CSV for BD/commercial prep (ADR 011/015/018).',
    description:
      "Tier-3 CSV of /api/admin/merchants/:merchantId/flywheel-activity. Columns: day,recycled_count,total_count,recycled_charge_minor,total_charge_minor. Filename includes merchantId so multi-merchant BD pulls don't collide.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Malformed merchantId',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/supplier-spend/activity.csv',
    summary: 'Daily × per-currency supplier-spend CSV (ADR 013/015/018).',
    description:
      "Tier-3 CSV of /api/admin/supplier-spend/activity. Columns: day,currency,count,face_value_minor,wholesale_minor,user_cashback_minor,loop_margin_minor. Finance runs this at month-end to reconcile CTX's invoice — wholesale_minor per (day, currency) should tie to CTX's line items. Zero-activity days emit day,,0,0,0,0,0. Window: ?days (default 31, cap 366). Row cap 10 000.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Unknown `currency`',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators-snapshot.csv',
    summary: 'Per-operator fleet snapshot CSV for CTX reviews (ADR 013/018/022).',
    description:
      'Tier-3 CSV joining operator-stats + operator-latency into one row per operator. Columns: operator_id,order_count,fulfilled_count,failed_count,success_pct,sample_count,p50_ms,p95_ms,p99_ms,mean_ms,last_order_at. Handed to CTX relationship owners for quarterly review meetings — SLA + volume + success rate on one sheet. Stats is the LEFT side: operators with orders but no fulfilled-with-timings samples get zero-filled latency columns. ?since default 24h, cap 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Invalid or out-of-window `since`',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

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
