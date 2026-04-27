/**
 * Admin user-cluster OpenAPI registrations
 * (ADR 009 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Six paths
 * that back the admin user-detail page and the user-directory
 * search/lookup surfaces — read-only, self-contained, no admin-
 * write or third-party dependencies. The three directory-style
 * paths are registered here; the three per-user-{userId} drill
 * paths live in `./admin-user-cluster-drill.ts` and are re-invoked
 * from this file's factory.
 *
 * Directory paths in this file:
 *   - GET /api/admin/users                          (paginated directory)
 *   - GET /api/admin/users/by-email                 (exact lookup)
 *   - GET /api/admin/users/top-by-pending-payout    (debt leaderboard)
 *
 * Per-user drill paths in the sibling file:
 *   - GET /api/admin/users/{userId}                 (single-user detail)
 *   - GET /api/admin/users/{userId}/credits         (per-user balance)
 *   - GET /api/admin/users/{userId}/credit-transactions (ledger drill)
 *
 * Locally-scoped schemas in this file:
 *   - AdminUserView (used by both /users/{userId} and
 *     /users/by-email — registered here, threaded into the drill
 *     factory so both consumers share one component instance)
 *   - AdminUserListRow / AdminUserListResponse
 *
 * Drill schemas (`AdminUserCreditRow` / `AdminUserCreditsResponse`,
 * `CreditTransactionType`, `AdminCreditTransactionView` /
 * `AdminCreditTransactionListResponse`) live with the drill paths
 * in the sibling file.
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminUserClusterDrillOpenApi } from './admin-user-cluster-drill.js';

/**
 * Registers the user-cluster paths + their locally-scoped schemas
 * on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminUserClusterOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — user detail ────────────────────────────────────────────────────

  const AdminUserView = registry.register(
    'AdminUserView',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.string().length(3),
      stellarAddress: z.string().nullable(),
      ctxUserId: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  // ─── Admin — user directory ─────────────────────────────────────────────────

  const AdminUserListRow = registry.register(
    'AdminUserListRow',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.string().length(3),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminUserListResponse = registry.register(
    'AdminUserListResponse',
    z.object({ users: z.array(AdminUserListRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users',
    summary: 'Paginated user directory.',
    description:
      'Newest-first paginated list of Loop users. Optional `?q=` filters emails with a case-insensitive `ILIKE` fragment match (LIKE metacharacters escaped). Cursor pagination via `?before=<iso-8601>` on `createdAt`. Cap via `?limit=` (default 20, max 100). Complements the exact-by-id drill at `/api/admin/users/:userId`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z.string().max(254).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'User rows (newest first)',
        content: { 'application/json': { schema: AdminUserListResponse } },
      },
      400: {
        description: 'Invalid q / before / limit',
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
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/by-email',
    summary: 'Exact-match user lookup by email.',
    description:
      "Support pastes the full email address from a customer ticket and gets the user row back in one request. Exact equality against a lowercase-normalised form — `Alice@Example.COM` matches `alice@example.com`. Distinct from `/api/admin/users?q=` which is the ILIKE-fragment browse surface; this one is the 'I have the address, give me the user' lookup. 404 on miss (no row exists for that normalised email).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        email: z.string().min(1).max(254),
      }),
    },
    responses: {
      200: {
        description: 'User row',
        content: { 'application/json': { schema: AdminUserView } },
      },
      400: {
        description: 'Missing, malformed, or overlong email',
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
        description: 'No user with that email',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
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
    path: '/api/admin/users/top-by-pending-payout',
    summary: 'Top users by outstanding on-chain payout obligation.',
    description:
      "Ranked by current unfilled payout debt. Grouped by `(user, asset)` so funding decisions stay per-asset — a user owed both USDLOOP and GBPLOOP appears twice, once per asset. Includes only rows in `state IN ('pending', 'submitted')`; `failed` rows aren't counted (triage them at `/admin/payouts?state=failed` — retrying them transitions them back to `pending` and rejoins this leaderboard). Complements `/api/admin/top-users` (lifetime earnings); this one ranks by *current debt*. `?limit=` clamped 1..100, default 20.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked (user, asset) entries',
        content: {
          'application/json': {
            schema: z.object({
              entries: z.array(
                z.object({
                  userId: z.string().uuid(),
                  email: z.string().email(),
                  assetCode: z.string(),
                  totalStroops: z.string(),
                  payoutCount: z.number().int().min(0),
                }),
              ),
            }),
          },
        },
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
        description: 'Internal error computing the leaderboard',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The three per-user-{userId} drill paths (`/users/{userId}`,
  // `/users/{userId}/credits`,
  // `/users/{userId}/credit-transactions`) plus their five
  // locally-scoped credit-related schemas live in
  // `./admin-user-cluster-drill.ts`. `AdminUserView` is registered
  // here in the parent because `/users/by-email` also returns it;
  // threaded into the drill factory so both consumers share the
  // same registered component instance.
  registerAdminUserClusterDrillOpenApi(registry, errorResponse, AdminUserView);
}
