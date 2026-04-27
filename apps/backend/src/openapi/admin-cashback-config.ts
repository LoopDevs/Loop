/**
 * Admin cashback-config CRUD OpenAPI registrations (ADR 011 / 017).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. This slice owns:
 *
 *   - The six cashback-config schemas (`AdminCashbackConfig`,
 *     `AdminCashbackConfigListResponse`,
 *     `AdminCashbackConfigEnvelope`,
 *     `UpsertCashbackConfigBody`,
 *     `AdminCashbackConfigHistoryRow`,
 *     `AdminCashbackConfigHistoryResponse`).
 *   - The five `/api/admin/merchant-cashback-configs*` paths
 *     (list, CSV, fleet history, per-merchant upsert, per-merchant
 *     history).
 *
 * None of those six schemas are referenced anywhere else in
 * admin.ts — they travel with the slice. Three dependencies cross
 * the boundary:
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

  // A2-502: ADR-017 envelope returned by the upsert endpoint. Mirrors
  // CreditAdjustmentEnvelope / RefundEnvelope — `result` is the updated
  // config row, `audit` is the shared admin-write audit shape that every
  // ADR-017 mutation returns.
  const AdminCashbackConfigEnvelope = registry.register(
    'AdminCashbackConfigEnvelope',
    z.object({
      result: AdminCashbackConfig,
      audit: AdminWriteAudit,
    }),
  );

  const UpsertCashbackConfigBody = registry.register(
    'UpsertCashbackConfigBody',
    z
      .object({
        wholesalePct: z.coerce.number().min(0).max(100),
        userCashbackPct: z.coerce.number().min(0).max(100),
        loopMarginPct: z.coerce.number().min(0).max(100),
        active: z.boolean().optional(),
        reason: z.string().min(2).max(500).openapi({
          description:
            'A2-502 / ADR 017: operator-authored rationale for the edit. Fanned out to the admin-audit Discord channel and (A2-908) persisted on any downstream ledger writes — NOT on the config row itself, which carries its own audit trail via the `merchant_cashback_config_history` trigger.',
        }),
      })
      .openapi({
        description:
          'The three split percentages are coerced from number-or-numeric-string and must sum to ≤100. `active` defaults to true on initial insert. `reason` is required per ADR 017 admin-write contract.',
      }),
  );

  const AdminCashbackConfigHistoryRow = registry.register(
    'AdminCashbackConfigHistoryRow',
    z.object({
      id: z.string().uuid(),
      merchantId: z.string(),
      wholesalePct: CashbackPctString,
      userCashbackPct: CashbackPctString,
      loopMarginPct: CashbackPctString,
      active: z.boolean(),
      changedBy: z.string().openapi({
        description: 'Admin user id that triggered the prior-row snapshot.',
      }),
      changedAt: z.string().datetime(),
    }),
  );

  const AdminCashbackConfigHistoryResponse = registry.register(
    'AdminCashbackConfigHistoryResponse',
    z.object({ history: z.array(AdminCashbackConfigHistoryRow) }),
  );

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

  registry.registerPath({
    method: 'put',
    path: '/api/admin/merchant-cashback-configs/{merchantId}',
    summary: 'Upsert a merchant cashback-split config (ADR 011 / ADR 017).',
    description:
      'INSERT on first touch, UPDATE otherwise. A Postgres trigger appends the pre-edit values to `merchant_cashback_config_history` so every change is auditable by `admin_user_id` + timestamp. A2-502: ADR-017 admin-write contract — `Idempotency-Key` header required, `reason` required in the body, response is the standard `{ result, audit }` envelope. A repeat PUT with the same actor+key replays the stored snapshot (`audit.replayed: true`).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'ADR 017 idempotency key — a UUID or any 16..128-char opaque token the client generates per click.',
        }),
      }),
      body: { content: { 'application/json': { schema: UpsertCashbackConfigBody } } },
    },
    responses: {
      200: {
        description: 'Updated row wrapped in the ADR-017 {result, audit} envelope',
        content: { 'application/json': { schema: AdminCashbackConfigEnvelope } },
      },
      400: {
        description:
          'Invalid body / missing Idempotency-Key / missing reason / percentages out of range / sum > 100 / malformed merchantId',
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
        description: 'DB write failed',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs/{merchantId}/history',
    summary: 'Audit-log history for one merchant cashback config (ADR 011).',
    description:
      'Up to 50 most-recent prior-state snapshots for a single merchant, newest first. Each row captures the exact values at the time of the change and who made it.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
    },
    responses: {
      200: {
        description: 'History rows (bounded to 50)',
        content: { 'application/json': { schema: AdminCashbackConfigHistoryResponse } },
      },
      400: {
        description: 'Missing merchantId',
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
    },
  });
}
