/**
 * Admin per-user-{userId} drill OpenAPI registrations
 * (ADR 009 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin-user-cluster.ts`
 * so the three per-user-{userId} drill paths sit alongside the
 * three credit-related schemas they share, separate from the
 * directory-style search/lookup paths in the parent file.
 *
 * Paths in the slice:
 *   - GET /api/admin/users/{userId}                     (single-user detail)
 *   - GET /api/admin/users/{userId}/credits             (per-user balance)
 *   - GET /api/admin/users/{userId}/credit-transactions (ledger drill)
 *
 * Five locally-scoped schemas travel with the slice:
 *   - `AdminUserCreditRow` / `AdminUserCreditsResponse`
 *   - `CreditTransactionType` (inline z.enum, not registered)
 *   - `AdminCreditTransactionView` / `AdminCreditTransactionListResponse`
 *
 * `AdminUserView` is registered in the parent file (also used by
 * `/users/by-email`); threaded in as a parameter so this module
 * doesn't re-register a duplicate component.
 *
 * Re-invoked from `registerAdminUserClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the per-user drill paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminUserClusterOpenApi`.
 */
export function registerAdminUserClusterDrillOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminUserView: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminUserView = adminUserView;

  // ─── Admin — per-user credit balance (ADR 009) ──────────────────────────────

  const AdminUserCreditRow = registry.register(
    'AdminUserCreditRow',
    z.object({
      currency: z.string().length(3),
      balanceMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units of the currency (cents, pence).',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const AdminUserCreditsResponse = registry.register(
    'AdminUserCreditsResponse',
    z.object({
      userId: z.string().uuid(),
      rows: z.array(AdminUserCreditRow),
    }),
  );

  // ─── Admin — per-user credit transactions (ADR 009) ─────────────────────────

  const CreditTransactionType = z
    .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
    .openapi({ description: 'Mirrors the CHECK constraint on credit_transactions.type.' });

  const AdminCreditTransactionView = registry.register(
    'AdminCreditTransactionView',
    z.object({
      id: z.string().uuid(),
      type: CreditTransactionType,
      amountMinor: z.string().openapi({
        description:
          'bigint-as-string, signed. Positive for cashback/interest/refund, negative for spend/withdrawal; adjustment can be either.',
      }),
      currency: z.string().length(3),
      referenceType: z.string().nullable(),
      referenceId: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminCreditTransactionListResponse = registry.register(
    'AdminCreditTransactionListResponse',
    z.object({ transactions: z.array(AdminCreditTransactionView) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}',
    summary: 'Single-user detail for the admin panel.',
    description:
      "Entry point for the admin panel's user-detail page. Returns the full user row — email, home currency, admin flag, Stellar address, CTX linkage, created/updated timestamps. Subsequent per-user drills (credits, credit-transactions, orders) key off the id this endpoint returns.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'User row',
        content: { 'application/json': { schema: AdminUserView } },
      },
      400: {
        description: 'Missing or malformed userId',
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
        description: 'User not found',
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
    path: '/api/admin/users/{userId}/credits',
    summary: 'Per-user credit balance drill-down (ADR 009).',
    description:
      'Returns every `user_credits` row for the given user. Ops opens this from a support ticket — complements the fleet-wide treasury aggregate by answering "what does Loop owe *this* user?". Empty `rows` is a valid response (user has never earned cashback or has fully redeemed).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Per-currency balances for the user',
        content: { 'application/json': { schema: AdminUserCreditsResponse } },
      },
      400: {
        description: 'Missing or malformed userId',
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
      500: {
        description: 'Internal error reading the ledger',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/credit-transactions',
    summary: 'Per-user credit-transaction log (ADR 009).',
    description:
      'Newest-first paginated list of `credit_transactions` rows for the user. The balance drill-down at `/api/admin/users/:userId/credits` answers "what is owed"; this endpoint answers "how did the balance get there?". Cursor pagination via `?before=<iso-8601>`; cap with `?limit=` (default 20, max 100); filter to a single kind with `?type=`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        type: CreditTransactionType.optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Credit-transaction rows (newest first)',
        content: { 'application/json': { schema: AdminCreditTransactionListResponse } },
      },
      400: {
        description: 'Invalid userId / type / before / limit',
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
      500: {
        description: 'Internal error reading the ledger',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
