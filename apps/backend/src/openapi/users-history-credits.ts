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
import { registerUsersCashbackHistoryOpenApi } from './users-cashback-history.js';

/**
 * Registers the user cashback-history + credits paths + their
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerUsersOpenApi`.
 */
export function registerUsersHistoryCreditsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
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

  // The two cashback-history paths
  // (`/api/users/me/cashback-history` JSON +
  // `/api/users/me/cashback-history.csv` export) and their two
  // locally-scoped schemas (`CashbackHistoryEntry`,
  // `CashbackHistoryResponse`) live in
  // `./users-cashback-history.ts`. Registered before the per-
  // currency credits path so OpenAPI path-registration order is
  // preserved.
  registerUsersCashbackHistoryOpenApi(registry, errorResponse);

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
