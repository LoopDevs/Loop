/**
 * Caller-scoped single-payout drill OpenAPI registrations
 * (ADR 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/users-pending-payouts.ts`
 * so the two single-row drill paths sit together separate from
 * the list + summary aggregates in the parent file:
 *
 *   - GET /api/users/me/pending-payouts/{id}       (by payout id)
 *   - GET /api/users/me/orders/{orderId}/payout    (by order id)
 *
 * Both paths return a single `UserPendingPayoutView`-shaped row.
 * Both deliberately 404 on cross-user access (not 403) so payout
 * ids and order ids stay non-enumerable. Both power the per-row
 * deep-link UX: the settings/cashback page links each payout, and
 * the per-order page surfaces the matching settlement state.
 *
 * `UserPendingPayoutView` is registered upstream in the parent
 * file (also used by the list path's response wrapper); threaded
 * in as a parameter so all three consumers keep the same
 * registered component instance.
 *
 * Re-invoked from `registerUsersPendingPayoutsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/users/me/pending-payouts/{id}` and
 * `/api/users/me/orders/{orderId}/payout` on the supplied registry.
 */
export function registerUsersPendingPayoutsDrillsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  userPendingPayoutView: ReturnType<OpenAPIRegistry['register']>,
): void {
  const UserPendingPayoutView = userPendingPayoutView;

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
