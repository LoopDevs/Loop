/**
 * Users section of the OpenAPI spec — schemas + path
 * registrations for `/api/users/me/*` (the caller-scoped self-
 * view surface: profile, cashback ledger, credits, trustlines,
 * pending payouts, flywheel stats, DSR exports).
 *
 * Fourth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `loopAssetCode` — LOOP-asset code enum (USDLOOP / GBPLOOP /
 *   EURLOOP). Defined inline in openapi.ts because the Admin
 *   section uses it too — passing it in keeps the spec byte-
 *   identical without duplicating the definition.
 * - `payoutState` — pending_payouts lifecycle enum (pending /
 *   submitted / confirmed / failed). Same cross-section share as
 *   loopAssetCode.
 *
 * Every schema + path is preserved verbatim (per-status response
 * descriptions, per-route comments, the cross-cutting note about
 * the pending-payouts schemas being declared down-section so the
 * PayoutState enum from Admin is available at the top of the
 * file). Generated spec is byte-identical to before this slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerUsersCashbackDrillOpenApi } from './users-cashback-drill.js';
import { registerUsersDsrOrdersOpenApi } from './users-dsr-orders.js';
import { registerUsersPendingPayoutsOpenApi } from './users-pending-payouts.js';
import { registerUsersProfileOpenApi } from './users-profile.js';

/**
 * Registers all `/api/users/me/*` schemas + paths on the
 * supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerUsersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
  payoutState: z.ZodTypeAny,
): void {
  // ─── User profile + Stellar (ADR 015) ──────────────────────────────────────
  //
  // Four caller-scoped paths backing the profile page + linked
  // Stellar wallet (/me, /me/home-currency, /me/stellar-address,
  // /me/stellar-trustlines) plus their five locally-scoped
  // schemas (UserMeView, SetHomeCurrencyBody, SetStellarAddressBody,
  // StellarTrustlineRow/Response) live in ./users-profile.ts.
  // Only `errorResponse` crosses the boundary.
  registerUsersProfileOpenApi(registry, errorResponse, loopAssetCode);

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

  // ─── Users pending-payouts cluster (ADR 015/016/024) ───────────────────────
  //
  // The four caller-scoped pending-payouts paths
  // (/pending-payouts list + /summary, /pending-payouts/{id},
  // and the nested /orders/{orderId}/payout lookup) plus their
  // four locally-scoped schemas (UserPendingPayoutView/Response,
  // UserPendingPayoutsSummaryRow/Response) live in
  // ./users-pending-payouts.ts. Threaded deps: shared
  // `errorResponse` and `payoutState`.
  registerUsersPendingPayoutsOpenApi(registry, errorResponse, payoutState);

  // ─── Users — cashback drill (ADR 009/010/015/022) ──────────────────────────
  //
  // Five caller-side cashback views — summary, by-merchant,
  // monthly, flywheel-stats, payment-method-share — plus their
  // four locally-scoped schemas live in
  // ./users-cashback-drill.ts. Only `errorResponse` crosses the
  // boundary.
  registerUsersCashbackDrillOpenApi(registry, errorResponse);

  // ─── Users DSR + orders-summary (GDPR / ADR 009/010/015) ───────────────────
  //
  // Three small tail paths that don't fit the cashback,
  // pending-payouts, or profile clusters: DSR delete (A2-1905),
  // DSR export (A2-1906), and the lifetime + MTD orders/summary
  // counter. Lifted into ./users-dsr-orders.ts. Only
  // `errorResponse` crosses the boundary.
  registerUsersDsrOrdersOpenApi(registry, errorResponse);
}
