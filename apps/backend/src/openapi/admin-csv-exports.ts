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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury/credit-flow.csv',
    summary: 'Daily × per-currency credit-flow CSV (ADR 009/015/018).',
    description:
      'Tier-3 CSV of /api/admin/treasury/credit-flow. Columns: day,currency,credited_minor,debited_minor,net_minor. Completes the finance-CSV quartet (cashback-activity, payouts-activity, supplier-spend/activity, this). Zero-activity days emit day,,0,0,0. With ?currency the LEFT JOIN generate_series gives a dense series. Row cap 10 000.',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury.csv',
    summary: 'Treasury snapshot CSV for SOC-2 / audit evidence (ADR 009/015/018).',
    description:
      'Point-in-time long-form CSV of the same aggregate /api/admin/treasury serves. Columns: metric,key,value. Metric vocabulary: snapshot_taken_at, outstanding, ledger_total, liability, liability_issuer, asset_stroops, payout_state, operator, operator_pool_size. Successive snapshots diff cleanly in audit tooling — auditors can eyeball which field moved between evidence runs. Reuses the JSON snapshot handler so no aggregate drift.',
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
      403: {
        description: 'Not an admin',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts.csv',
    summary: 'CSV export of pending_payouts (ADR 015).',
    description:
      'Finance-ready CSV of pending_payouts rows in a time window — monthly reconciliation against the Stellar ledger. Default window is 31 days; pass `?since=<iso-8601>` to override. Capped at 366 days and 10 000 rows — past 10 000, the response emits a trailing `__TRUNCATED__` sentinel row and log-warns the real rowCount. `Cache-Control: private, no-store` + `Content-Disposition: attachment` so the browser drops it straight to disk.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row lists every pending_payouts column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for amount_stroops; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
        description: 'Rate limit exceeded (10/min per IP)',
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
    path: '/api/admin/audit-tail.csv',
    summary: 'CSV export of admin write-audit trail (ADR 017 / 018).',
    description:
      'Finance / legal CSV of `admin_idempotency_keys` rows in a time window, joined to `users` for the actor email. SOC-2 / compliance export: a neutral-format dump of "who did what, when" that ops can hand to auditors without exposing the stored response bodies. Default window 31 days, capped at 366. Row cap 10 000 — past the cap, a trailing `__TRUNCATED__` sentinel row signals the window needs narrowing (and the handler log-warns the real rowCount). `Cache-Control: private, no-store` + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row: actor_user_id, actor_email, method, path, status, idempotency_key, created_at. ISO-8601 for the timestamp; response bodies intentionally omitted.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
        description: 'Rate limit exceeded (10/min per IP)',
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
    path: '/api/admin/orders.csv',
    summary: 'CSV export of Loop-native orders (ADR 011 / 015).',
    description:
      'Finance-ready CSV of `orders` rows in a time window. Month-end reconciliation: face-value totals against the CTX invoice, user-cashback totals against the ledger accrual feed, loop-margin totals against P&L. Default window 31 days, capped at 366 days. Row cap 10 000 — past that, a `__TRUNCATED__` sentinel row trails the output and the handler log-warns the real rowCount. Gift-card fields (redeem_code / redeem_pin / redeem_url) are omitted — this export is for reconciliation, not redemption.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row lists every exposed orders column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for all `*_minor` columns; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
