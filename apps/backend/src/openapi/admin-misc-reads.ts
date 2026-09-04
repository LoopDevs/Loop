/**
 * Admin miscellaneous reads OpenAPI registrations
 * (merchant-flows, reconciliation, user-search).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. Three independent read endpoints that
 * sat between the treasury+payouts block and the cashback-config
 * CRUD section in the original file:
 *
 *   - `GET /api/admin/merchant-flows` — per-(merchant, currency)
 *     fulfilled-order flow aggregate (ADR 011 / 015).
 *   - `GET /api/admin/reconciliation` — ledger drift check
 *     between user_credits and the credit_transactions ledger
 *     sum (ADR 009).
 *   - `GET /api/admin/users/search` — case-insensitive email
 *     substring lookup with a 20-row cap (ADR 011).
 *
 * They land in one slice because each is short, none share
 * schemas with anywhere else in admin.ts, and they cluster
 * together as "ad-hoc admin reads that don't fit the per-merchant
 * or per-user drill triplet". Six locally-scoped schemas travel
 * with the slice:
 *
 *   - `MerchantFlow`, `MerchantFlowsResponse`
 *   - `ReconciliationEntry`, `ReconciliationResponse`
 *   - `AdminUserSearchResult`, `AdminUserSearchResponse`
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminUserSearchOpenApi } from './admin-user-search.js';

/**
 * Registers the three miscellaneous-read paths + their
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerAdminOpenApi`.
 */
export function registerAdminMiscReadsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — ledger reconciliation (ADR 009) ────────────────────────────────

  const ReconciliationEntry = registry.register(
    'ReconciliationEntry',
    z.object({
      userId: z.string().uuid(),
      currency: z.string(),
      balanceMinor: z.string().openapi({
        description: 'Materialised balance from user_credits.balance_minor. BigInt-string.',
      }),
      ledgerSumMinor: z.string().openapi({
        description:
          'Sum of credit_transactions.amount_minor for this (user, currency). BigInt-string.',
      }),
      deltaMinor: z.string().openapi({
        description: 'balance - ledger_sum. Non-zero by construction (drift query filters on !=).',
      }),
    }),
  );

  const ReconciliationResponse = registry.register(
    'ReconciliationResponse',
    z.object({
      rowCount: z.string().openapi({
        description:
          'Total user_credits rows across all users and currencies. A multi-currency user contributes one row per currency — this is NOT a distinct-user count (A2-907). BigInt-string.',
      }),
      driftedCount: z.string().openapi({
        description:
          'Number of drifted rows returned in `drift`. Capped at 100 — more may exist beyond.',
      }),
      drift: z.array(ReconciliationEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/reconciliation',
    summary: 'Ledger-integrity drift check (ADR 009).',
    description:
      "Joins `user_credits` against the grouped sum of `credit_transactions` per (user_id, currency) and returns any rows where they disagree. A healthy deployment returns an empty `drift` array. The `driftedCount` is capped at 100 to keep responses bounded; a catastrophic divergence surfaces but isn't exhaustively listed.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Drift report',
        content: { 'application/json': { schema: ReconciliationResponse } },
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
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The user-search path lives in `./admin-user-search.ts` along
  // with its two locally-scoped schemas. Same path-registration
  // position as the original block.
  registerAdminUserSearchOpenApi(registry, errorResponse);
}
