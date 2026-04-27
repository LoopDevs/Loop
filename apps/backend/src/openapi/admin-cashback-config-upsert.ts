/**
 * Admin cashback-config upsert OpenAPI registration
 * (ADR 011 / 017 / A2-502).
 *
 * Lifted out of `./admin-cashback-config.ts`. The upsert is the
 * only write in the cashback-config CRUD surface — it carries the
 * full ADR-017 admin-write contract (Idempotency-Key header,
 * `reason` body field, `{ result, audit }` envelope, replay-on-
 * repeat). Pulling it into its own slice leaves the parent file
 * focused on the read paths (list, CSV, fleet history) plus the
 * per-merchant history sibling.
 *
 * Path in the slice:
 *   - PUT /api/admin/merchant-cashback-configs/{merchantId}
 *
 * Two locally-scoped schemas travel with it:
 *   - `UpsertCashbackConfigBody`
 *   - `AdminCashbackConfigEnvelope` (only referenced by the upsert
 *     response shape; staying with it keeps the slice self-contained)
 *
 * Three deps cross the boundary:
 *   - `errorResponse` (shared component from openapi.ts).
 *   - `adminCashbackConfig` — the read shape `AdminCashbackConfig`
 *     embedded in the envelope's `result` field. Stays in the
 *     parent because the list + history slices reference it too;
 *     threading it in keeps every consumer pointing at the same
 *     registered schema instance.
 *   - `adminWriteAudit` — the ADR-017 audit envelope shape; same
 *     threading pattern as the credit-write / withdrawal slices
 *     (#1166 / #1265).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the upsert path + its locally-scoped schemas on the
 * supplied registry. Called once from
 * `registerAdminCashbackConfigOpenApi`.
 */
export function registerAdminCashbackConfigUpsertOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminCashbackConfig: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local aliases preserve the PascalCase identifiers the section
  // body used pre-decomposition.
  const AdminCashbackConfig = adminCashbackConfig;
  const AdminWriteAudit = adminWriteAudit;

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
}
