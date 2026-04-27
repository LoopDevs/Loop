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

/**
 * Registers the three miscellaneous-read paths + their
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerAdminOpenApi`.
 */
export function registerAdminMiscReadsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — per-merchant fulfilled-order flows (ADR 011 / 015) ─────────────

  const MerchantFlow = registry.register(
    'MerchantFlow',
    z.object({
      merchantId: z.string(),
      currency: z.string().openapi({ description: 'ISO charge currency for this bucket.' }),
      count: z.string().openapi({
        description: 'Number of fulfilled orders in this bucket. BigInt-string count.',
      }),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string().openapi({ description: 'Total paid to CTX (supplier).' }),
      userCashbackMinor: z.string().openapi({ description: 'Total credited to users.' }),
      loopMarginMinor: z.string().openapi({ description: 'Total kept by Loop.' }),
    }),
  );

  const MerchantFlowsResponse = registry.register(
    'MerchantFlowsResponse',
    z.object({ flows: z.array(MerchantFlow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-flows',
    summary: 'Aggregated fulfilled-order flow per (merchant, charge currency) (ADR 011 / 015).',
    description:
      "Groups `orders` WHERE `state='fulfilled'` by `merchant_id` + `charge_currency`, summing face/wholesale/cashback/margin. Feeds the per-row 'actual vs configured' display on /admin/cashback so ops can spot merchants whose real split doesn't match their configured cashback.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-merchant flow buckets',
        content: { 'application/json': { schema: MerchantFlowsResponse } },
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
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — user search (ADR 011) ──────────────────────────────────────────

  const AdminUserSearchResult = registry.register(
    'AdminUserSearchResult',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminUserSearchResponse = registry.register(
    'AdminUserSearchResponse',
    z.object({
      users: z.array(AdminUserSearchResult),
      truncated: z.boolean().openapi({
        description:
          'True when more matches exist beyond the 20-row cap. Hint for the caller to narrow the query.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/search',
    summary: 'Find users by email fragment (ADR 011).',
    description:
      'Case-insensitive email substring match (ILIKE). Minimum 2 chars, maximum 254 (RFC 5321 email length cap). Ordered by createdAt DESC, limit 20. Returns `truncated: true` when more matches exist beyond the cap. Wildcards (% / _) in the query are escaped so they match literally.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z
          .string()
          .min(2)
          .max(254)
          .openapi({ description: 'Email substring — case-insensitive. 2-254 chars.' }),
      }),
    },
    responses: {
      200: {
        description: 'Search results',
        content: { 'application/json': { schema: AdminUserSearchResponse } },
      },
      400: {
        description: 'q missing, too short, or too long',
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
}
