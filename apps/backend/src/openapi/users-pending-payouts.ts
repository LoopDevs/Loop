/**
 * User pending-payouts OpenAPI registrations
 * (ADR 015 / 016 / 024).
 *
 * Lifted out of `apps/backend/src/openapi/users.ts`. Four caller-
 * scoped read paths covering the on-chain payout queue from the
 * user's perspective:
 *
 *   - GET /api/users/me/pending-payouts            (full list)
 *   - GET /api/users/me/pending-payouts/summary    (per-(asset, state) totals)
 *   - GET /api/users/me/pending-payouts/{id}       (single-row drill)
 *   - GET /api/users/me/orders/{orderId}/payout    (nested by-order lookup)
 *
 * Locally-scoped schemas travel with the slice (none referenced
 * elsewhere in users.ts):
 *
 *   - `UserPendingPayoutView` — trimmed subset of `AdminPayoutView`
 *     (no `userId`, `toAddress`, or `memoText` — the caller knows
 *     they\'re looking at their own account, and exposing the dest
 *     wallet / memo leaks internals without value).
 *   - `UserPendingPayoutsResponse`
 *   - `UserPendingPayoutsSummaryRow` / `Response`
 *
 * Two deps cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts).
 *   - `payoutState` — cross-section enum, also used by the admin
 *     section. The schema body composes it into the
 *     `UserPendingPayoutView` shape; threading as a parameter keeps
 *     the registered schema instance stable across consumers.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the user pending-payouts paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerUsersOpenApi`.
 */
export function registerUsersPendingPayoutsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  payoutState: z.ZodTypeAny,
): void {
  // ─── Users — pending-payouts view (ADR 015 / 016) ──────────────────────────
  //
  // Registered down here (outside the Users schema block) so the `PayoutState`
  // enum from the Admin section is available. The shape is a trimmed subset of
  // `AdminPayoutView` — no `userId`, `toAddress`, or `memoText` because the
  // user already knows they're looking at their own account, and surfacing the
  // destination wallet / memo would expose internals without adding value.

  const UserPendingPayoutView = registry.register(
    'UserPendingPayoutView',
    z.object({
      id: z.string().uuid(),
      orderId: z.string().uuid().nullable().openapi({
        description:
          "Origin order id for order-fulfilment cashback payouts; null for kind='withdrawal' (A2-901 / ADR-024 §2).",
      }),
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      assetIssuer: z.string().openapi({ description: 'Stellar issuer account for this asset.' }),
      amountStroops: z
        .string()
        .openapi({ description: 'Payout amount in stroops (7 decimals). BigInt as string.' }),
      state: payoutState,
      txHash: z.string().nullable().openapi({
        description: 'Confirmed Stellar tx hash — null until the payout is confirmed on-chain.',
      }),
      attempts: z.number().int(),
      createdAt: z.string().datetime(),
      submittedAt: z.string().datetime().nullable(),
      confirmedAt: z.string().datetime().nullable(),
      failedAt: z.string().datetime().nullable(),
    }),
  );

  const UserPendingPayoutsResponse = registry.register(
    'UserPendingPayoutsResponse',
    z.object({ payouts: z.array(UserPendingPayoutView) }),
  );

  const UserPendingPayoutsSummaryRow = registry.register(
    'UserPendingPayoutsSummaryRow',
    z.object({
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      state: z.enum(['pending', 'submitted']),
      count: z.number().int().nonnegative(),
      totalStroops: z.string().openapi({
        description: 'Sum of `amount_stroops` in the bucket. BigInt as string.',
      }),
      oldestCreatedAt: z.string().datetime(),
    }),
  );

  const UserPendingPayoutsSummaryResponse = registry.register(
    'UserPendingPayoutsSummaryResponse',
    z.object({ rows: z.array(UserPendingPayoutsSummaryRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/pending-payouts',
    summary: "Caller's on-chain payout rows (ADR 015 / 016).",
    description:
      "Returns the user's own `pending_payouts` rows — one row per outbound LOOP-asset payment tracked through its lifecycle (`pending → submitted → confirmed | failed`). Mirrors the admin endpoint's query shape (`?state=`, `?before=`, `?limit=`) but is scoped to the authenticated caller by `userId` — no admin-privileged cross-user access. Clients poll this from the wallet / cashback settings views while a payout is in flight.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: payoutState.optional().openapi({
          description: 'Filter to a single lifecycle state. Omitted → all states.',
        }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
      }),
    },
    responses: {
      200: {
        description: 'Payout rows, newest first',
        content: { 'application/json': { schema: UserPendingPayoutsResponse } },
      },
      400: {
        description: 'Invalid state or before',
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
    path: '/api/users/me/pending-payouts/summary',
    summary: "Caller's pending-payouts aggregate (ADR 015 / 016).",
    description:
      "Aggregate view of the caller's in-flight payouts bucketed by `(asset_code, state)`. One round-trip replaces paging the full list when a UI only needs the 'you have $X cashback settling' signal. Excludes `confirmed` rows (they're in the cashback history feed) and `failed` rows (they belong to the admin retry flow, not the user's in-flight view). Empty `rows` when the caller has no in-flight payouts.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per (assetCode, state) bucket',
        content: { 'application/json': { schema: UserPendingPayoutsSummaryResponse } },
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
    path: '/api/users/me/pending-payouts/{id}',
    summary: 'Caller-scoped single payout detail (ADR 015 / 016).',
    description:
      "Permalink for one of the caller's `pending_payouts` rows. The settings/cashback page deep-links each row so the user can share the URL with support when asking about a stuck payout. Cross-user access returns 404 (not 403) so payout ids aren't enumerable.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: UserPendingPayoutView } },
      },
      400: {
        description: 'Missing or malformed id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Payout not found (or owned by a different user)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
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
    path: '/api/users/me/orders/{orderId}/payout',
    summary: 'Per-order cashback settlement drill (ADR 015 / 016).',
    description:
      "For one of the caller's own orders, return the single pending-payout row tied to it. Mirror of the admin `/api/admin/orders/{orderId}/payout` but ownership-scoped: (orderId, userId) predicate guarantees cross-user access returns 404 (not 403), so order ids aren't enumerable. Powers the per-order settlement card on `/orders/:id` — users see Stellar-side state (pending / submitted / confirmed / failed) next to the gift-card redemption. Null result when the order has no payout row yet (pre-cashback, credit-only ledger, or order doesn't belong to the caller).",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row for the order',
        content: { 'application/json': { schema: UserPendingPayoutView } },
      },
      400: {
        description: 'Missing or malformed orderId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: "No payout row for this order (or order doesn't belong to caller)",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
