/**
 * User cashback-history + credits OpenAPI registrations
 * (ADR 009 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/users.ts` as the final
 * extraction slice. Three caller-scoped read paths covering the
 * credit-ledger journal + balance:
 *
 *   - GET /api/users/me/cashback-history       (paginated journal)
 *   - GET /api/users/me/cashback-history.csv   (one-shot CSV dump)
 *   - GET /api/users/me/credits                (per-currency balance)
 *
 * Four locally-scoped schemas travel with the slice:
 *
 *   - `CashbackHistoryEntry` / `CashbackHistoryResponse`
 *   - `UserCreditRow` / `UserCreditsResponse`
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the user cashback-history + credits paths + their
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerUsersOpenApi`.
 */
export function registerUsersHistoryCreditsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const CashbackHistoryEntry = registry.register(
    'CashbackHistoryEntry',
    z.object({
      id: z.string().uuid(),
      type: z
        .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
        .openapi({ description: 'Ledger event kind — see `credit_transactions.type` (ADR 009).' }),
      amountMinor: z.string().openapi({
        description:
          'Pence / cents in `currency`, as a bigint-string. Positive for cashback / interest / refund, negative for spend / withdrawal, either for adjustment.',
      }),
      currency: z.string().length(3),
      referenceType: z.string().nullable().openapi({
        description: "Source tag, e.g. `'order'`. Null when support-adjusted directly.",
      }),
      referenceId: z.string().nullable().openapi({
        description: 'Matching reference id (e.g. order UUID).',
      }),
      createdAt: z.string().datetime(),
    }),
  );

  const CashbackHistoryResponse = registry.register(
    'CashbackHistoryResponse',
    z.object({ entries: z.array(CashbackHistoryEntry) }),
  );

  // ─── Users — credit balances (ADR 009 / 015) ────────────────────────────────

  const UserCreditRow = registry.register(
    'UserCreditRow',
    z.object({
      currency: z.string().length(3),
      balanceMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const UserCreditsResponse = registry.register(
    'UserCreditsResponse',
    z.object({ credits: z.array(UserCreditRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-history',
    summary: 'Recent credit-ledger events for the caller (ADR 009 / 015).',
    description:
      "Paginated cashback / interest / spend / withdrawal / refund / adjustment rows for the authenticated user. Page older rows with `?before=<iso-8601>`; cap the page size with `?limit=` (default 20, hard-capped at 100). Always scoped to the caller — admins use the separate `/api/admin/*` surfaces to inspect other users' ledgers.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
      }),
    },
    responses: {
      200: {
        description: 'Ledger entries, newest first',
        content: { 'application/json': { schema: CashbackHistoryResponse } },
      },
      400: {
        description: 'Invalid before timestamp',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-history.csv',
    summary: 'Full credit-ledger CSV export for the caller (ADR 009).',
    description:
      "One-shot CSV dump of the caller's credit-ledger history. Columns: Created (UTC), Type, Amount (minor), Currency, Reference type, Reference ID. Capped at 10 000 rows; the `X-Result-Count` response header reports the actual row count so the client can warn when the cap is hit. Tighter rate limit (6/min) than the JSON sibling because the query is unbounded in size.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description:
          'CSV attachment — Content-Disposition: attachment; filename="loop-cashback-history.csv".',
        content: { 'text/csv': { schema: z.string() } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (6/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/credits',
    summary: 'Caller per-currency credit balance (ADR 009 / 015).',
    description:
      'Multi-currency complement to `/api/users/me`, which exposes only the home-currency scalar. Returns one row per non-zero `user_credits` currency — useful after a home-currency flip leaves a residual balance, or when support credits a user in a non-home currency. Empty `credits` when the user has never earned / has fully redeemed.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-currency balances',
        content: { 'application/json': { schema: UserCreditsResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
