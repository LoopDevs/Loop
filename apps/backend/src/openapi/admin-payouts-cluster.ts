/**
 * Admin payouts-cluster OpenAPI registrations
 * (ADR 015 / 016 / 017 / 024).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Six paths that
 * back the /admin/payouts surface and the two ADR-017-shaped write
 * actions on the row drill (retry + compensate).
 *
 * Paths in the slice:
 *   - GET  /api/admin/payouts                     (paginated backlog)
 *   - GET  /api/admin/payouts/{id}                (single-row drill)
 *   - GET  /api/admin/payouts-by-asset            (per-(asset, state) totals)
 *   - GET  /api/admin/payouts/settlement-lag      (percentile SLA)
 *   - POST /api/admin/payouts/{id}/retry          (ADR 017 retry)
 *   - POST /api/admin/payouts/{id}/compensate     (ADR-024 §5 compensate)
 *
 * Locally-scoped schemas travel with the slice:
 *   - `AdminPayoutListResponse`
 *   - `PerStateBreakdown` / `PayoutsByAssetRow` / `PayoutsByAssetResponse`
 *   - `SettlementLagRow` / `SettlementLagResponse`
 *   - `PayoutRetryBody` / `PayoutRetryEnvelope`
 *   - `PayoutCompensationBody` / `PayoutCompensationResult` / `PayoutCompensationEnvelope`
 *
 * Three deps cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts).
 *   - `adminPayoutView` — the row shape returned by /payouts/{id}
 *     and embedded in the retry envelope. Stays in admin.ts because
 *     ./admin-order-cluster.ts also uses it (#1177); threading it
 *     in keeps every consumer pointing at the same registered
 *     schema instance.
 *   - `adminWriteAudit` — embedded in the retry + compensate
 *     envelopes; same threading pattern as #1166 / #1175.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the payouts-cluster paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
type ZodEnumLike = z.ZodEnum<{ readonly [key: string]: string | number }>;

export function registerAdminPayoutsClusterOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  payoutState: ZodEnumLike,
  adminPayoutView: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  // Local aliases keep the body syntactically identical to the
  // pre-decomposition source.
  const PayoutState = payoutState;
  const AdminPayoutView = adminPayoutView;
  const AdminWriteAudit = adminWriteAudit;

  const AdminPayoutListResponse = registry.register(
    'AdminPayoutListResponse',
    z.object({ payouts: z.array(AdminPayoutView) }),
  );

  // ─── Admin — payouts-by-asset breakdown (ADR 015 / 016) ────────────────────

  const PerStateBreakdown = registry.register(
    'PerStateBreakdown',
    z.object({
      count: z.number().int().min(0),
      stroops: z.string().openapi({ description: 'Sum of amount_stroops; bigint-as-string.' }),
    }),
  );

  const PayoutsByAssetRow = registry.register(
    'PayoutsByAssetRow',
    z.object({
      assetCode: z.string(),
      pending: PerStateBreakdown,
      submitted: PerStateBreakdown,
      confirmed: PerStateBreakdown,
      failed: PerStateBreakdown,
    }),
  );

  const PayoutsByAssetResponse = registry.register(
    'PayoutsByAssetResponse',
    z.object({ rows: z.array(PayoutsByAssetRow) }),
  );

  // ─── Admin — settlement-lag SLA (ADR 015 / 016) ────────────────────────────

  const SettlementLagRow = registry.register(
    'SettlementLagRow',
    z.object({
      assetCode: z.string().nullable().openapi({
        description: 'LOOP asset code; `null` for the fleet-wide aggregate row.',
      }),
      sampleCount: z.number().int().nonnegative(),
      p50Seconds: z.number().nonnegative(),
      p95Seconds: z.number().nonnegative(),
      maxSeconds: z.number().nonnegative(),
      meanSeconds: z.number().nonnegative(),
    }),
  );

  const SettlementLagResponse = registry.register(
    'SettlementLagResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(SettlementLagRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts',
    summary: 'Paginated pending-payouts backlog (ADR 015).',
    description:
      'Admin drills into the payouts page from the treasury snapshot state counts. Filter with `?state=failed` (or pending / submitted / confirmed), page older rows with `?before=<iso-8601>`, cap with `?limit=` (default 20, max 100).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: PayoutState.optional().openapi({
          description: 'Filter to a single lifecycle state. Omitted → all states.',
        }),
        userId: z.string().uuid().optional().openapi({
          description:
            'Filter to a single user. Powers the user-detail payouts section — without this ops would have to grep through the full list for a user.',
        }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — return rows strictly older than this createdAt.' }),
        limit: z.coerce.number().int().min(1).max(100).optional().openapi({
          description: 'Page size. Default 20, hard-capped at 100.',
        }),
        kind: z.enum(['order_cashback', 'withdrawal']).optional().openapi({
          description:
            'ADR-024 §2 discriminator filter. `order_cashback` = legacy order-fulfilment payout; `withdrawal` = admin cash-out from balance. Omitted → both.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Payout rows',
        content: { 'application/json': { schema: AdminPayoutListResponse } },
      },
      400: {
        description: 'Invalid state or before',
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
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts/{id}',
    summary: 'Single pending-payout drill-down (ADR 015).',
    description:
      'Permalink view for one pending_payouts row, used by the admin UI to deep-link a stuck / failed payout into a ticket or incident note without scrolling the list. 404 when the id matches nothing.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: AdminPayoutView } },
      },
      400: {
        description: 'Missing or malformed id',
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
      404: {
        description: 'Payout not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-by-asset',
    summary: 'Per-asset × per-state payout breakdown (ADR 015 / 016).',
    description:
      "Crosses `pending_payouts` by `(asset_code, state)`. The treasury snapshot gives per-state counts and per-asset outstanding liability separately; this endpoint answers the crossed question ops asks during an incident — 'I see N failed payouts, which LOOP assets are affected?'. All amounts in stroops, bigint-as-string.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per asset_code present in pending_payouts',
        content: { 'application/json': { schema: PayoutsByAssetResponse } },
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
        description: 'Internal error computing the breakdown',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts/settlement-lag',
    summary: 'Payout settlement-lag SLA (ADR 015 / 016).',
    description:
      "Percentile latency (in seconds) from `pending_payouts` insert (`createdAt`) to on-chain confirmation (`confirmedAt`) for `state='confirmed'` rows in the window. One row per LOOP asset, plus a fleet-wide aggregate where `assetCode: null`. The user-facing SLA: if p95 is minutes we're healthy; hours means the payout worker or Horizon is backed up and users are waiting. Window: `?since=<iso>` (default 24h, cap 366d). Same clamp as the operator-latency endpoint.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description: 'ISO-8601 — lower bound on `confirmedAt`. Defaults to 24h ago.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Per-asset rows plus fleet-wide aggregate',
        content: { 'application/json': { schema: SettlementLagResponse } },
      },
      400: {
        description: 'Malformed `since` or window > 366d',
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

  const PayoutRetryBody = registry.register(
    'PayoutRetryBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutRetryEnvelope = registry.register(
    'PayoutRetryEnvelope',
    z.object({
      result: AdminPayoutView,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/retry',
    summary: 'Flip a failed payout back to pending (ADR 015 / 016 / 017).',
    description:
      'Admin-only manual retry: resets a `failed` pending_payouts row to `pending` so the submit worker picks it up on the next tick. 404 when the id matches nothing or the row is in a non-failed state. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. Worker enforces memo-idempotency on re-submit (ADR 016) so double-retry never double-pays.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutRetryBody } },
      },
    },
    responses: {
      200: {
        description: 'Retry applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutRetryEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or malformed id',
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
      404: {
        description: 'Payout not found or not in failed state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resetting the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PayoutCompensationBody = registry.register(
    'PayoutCompensationBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutCompensationResult = registry.register(
    'PayoutCompensationResult',
    z.object({
      id: z.string().uuid(),
      payoutId: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      amountMinor: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const PayoutCompensationEnvelope = registry.register(
    'PayoutCompensationEnvelope',
    z.object({
      result: PayoutCompensationResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/compensate',
    summary: 'Compensate a permanently-failed withdrawal payout (ADR-024 §5).',
    description:
      'Re-credits the user after their withdrawal payout permanently failed on-chain. Writes a positive `type=adjustment` row referencing the payout id; net result is the original withdrawal debit is offset and the user is back to where they started. Manual-only (Phase 2a) — finance reviews failures before triggering. 400 if the payout is not a withdrawal; 409 if the payout is in any state other than `failed`. ADR 017 compliant: `Idempotency-Key` header + `reason` body required.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutCompensationBody } },
      },
    },
    responses: {
      200: {
        description: 'Compensation applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutCompensationEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid reason, malformed id, or payout is not a withdrawal',
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
      404: {
        description: 'Payout not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: "Payout is not in 'failed' state — only failed payouts can be compensated",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying compensation',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
