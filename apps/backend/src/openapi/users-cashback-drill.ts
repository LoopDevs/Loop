/**
 * User cashback-drill OpenAPI registrations
 * (ADR 009 / 010 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/users.ts`. Five paths
 * that back the caller-side cashback drill — every "self" view
 * the /orders, /settings/cashback, and home pages render, plus
 * the per-merchant / per-month breakdowns and the rail-mix +
 * flywheel-stats self-views (ADR 022 quartet, self axis):
 *
 *   - GET /api/users/me/cashback-summary
 *   - GET /api/users/me/cashback-by-merchant
 *   - GET /api/users/me/cashback-monthly
 *   - GET /api/users/me/flywheel-stats
 *   - GET /api/users/me/payment-method-share
 *
 * Locally-scoped schemas travel with the slice (none referenced
 * elsewhere in users.ts):
 *
 *   - `UserCashbackSummary`
 *   - `UserCashbackByMerchantRow` / `Response`
 *   - `UserFlywheelStats`
 *   - `UserPaymentMethodShareResponseSelf` (registered name; the
 *     local const is `UserPaymentMethodShareResponseUserSelf` to
 *     disambiguate from the admin-side mirror)
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the user cashback-drill paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerUsersOpenApi`.
 */
export function registerUsersCashbackDrillOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const UserCashbackSummary = registry.register(
    'UserCashbackSummary',
    z.object({
      currency: z.string().length(3),
      lifetimeMinor: z.string(),
      thisMonthMinor: z.string(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-summary',
    summary: 'Compact lifetime + this-month cashback totals (ADR 009 / 015).',
    description:
      "Two-number headline the home / cashback pages render: `lifetimeMinor` is all-time cashback earned, `thisMonthMinor` resets at 00:00 UTC on the 1st. Both filter to `type='cashback'` in the user's current `home_currency` — no cross-currency sum (rare multi-currency users see only their home-currency earnings; admin ledger has cross-currency detail). `bigint`-minor units as strings.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Cashback summary',
        content: { 'application/json': { schema: UserCashbackSummary } },
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
        description: 'Internal error computing the summary',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const UserCashbackByMerchantRow = registry.register(
    'UserCashbackByMerchantRow',
    z.object({
      merchantId: z.string(),
      cashbackMinor: z.string(),
      orderCount: z.number().int().nonnegative(),
      lastEarnedAt: z.string().datetime(),
    }),
  );

  const UserCashbackByMerchantResponse = registry.register(
    'UserCashbackByMerchantResponse',
    z.object({
      currency: z.string().length(3),
      since: z.string().datetime(),
      rows: z.array(UserCashbackByMerchantRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-by-merchant',
    summary: 'Top cashback-earning merchants for the caller (ADR 009 / 015).',
    description:
      "Groups the caller's `credit_transactions` (type='cashback', filtered to `home_currency`) by the source order's `merchant_id`. Each row carries earned cashback (bigint-minor as string), distinct order count, and the most-recent ledger-row timestamp. Default window 180 days; server clamps `?since=` to 366d and `?limit=` to 50. Sorted cashback DESC, ties break on lastEarnedAt DESC. `merchantId` is the catalog slug — clients resolve display name via the merchant catalog rather than paying for another round-trip here.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description:
            'ISO-8601 lower bound on `created_at`. Defaults to 180d ago; capped at 366d.',
        }),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Top-N rows in the window, ordered by cashback DESC',
        content: { 'application/json': { schema: UserCashbackByMerchantResponse } },
      },
      400: {
        description: 'Invalid `since` (or window over 366d)',
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
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/cashback-monthly',
    summary: 'Last 12 months of cashback totals grouped by (month, currency).',
    description:
      "Time-axis aggregate of the caller's cashback ledger. `DATE_TRUNC('month', created_at AT TIME ZONE 'UTC')` → `(month, currency)` with `SUM(amount_minor)` filtered to `type='cashback'`. Fixed 12-month window (current UTC month + previous 11). Oldest-first so the bar chart renders left-to-right without a client reverse. Multi-currency safe — a user who moved regions gets both currency entries per month. `cashbackMinor` is bigint-as-string so fleet-wide sums don't truncate.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Monthly entries, oldest first',
        content: {
          'application/json': {
            schema: z.object({
              entries: z.array(
                z.object({
                  month: z.string().regex(/^\d{4}-\d{2}$/),
                  currency: z.string().length(3),
                  cashbackMinor: z.string(),
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

  // User-facing flywheel + rail-mix pivot endpoints (ADR 015 / 022).
  // These are the self-view counterparts to the admin per-user endpoints
  // — same shapes, keyed on auth context instead of path param.

  const UserFlywheelStats = registry.register(
    'UserFlywheelStats',
    z.object({
      currency: z.string().length(3).openapi({
        description:
          "Caller's home_currency — both numerator and denominator scoped to it so the ratio shares a denomination.",
      }),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalFulfilledCount: z.number().int(),
      totalFulfilledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/flywheel-stats',
    summary: 'Caller-scoped recycled-vs-total scalar (ADR 015).',
    description:
      "Powers the FlywheelChip on /orders and /settings/cashback. Answers the user's question: 'how much of my spend came back to me as cashback I then spent again?'. Home-currency-locked. Zero-recycled users get zeroed fields (not 404) — the chip self-hides on zero via client-side check.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Caller recycled-vs-total flywheel scalar',
        content: { 'application/json': { schema: UserFlywheelStats } },
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const UserPaymentMethodShareResponseUserSelf = registry.register(
    'UserPaymentMethodShareResponseSelf',
    z.object({
      currency: z.string().length(3),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z.object({
        xlm: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        usdc: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        credit: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
        loop_asset: z.object({
          orderCount: z.number().int(),
          chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
        }),
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/payment-method-share',
    summary: "Caller's own rail mix (ADR 010/015).",
    description:
      'User-facing self-view of the payment-method-share quartet (fleet / per-merchant / per-user admin / self). Powers the RailMixCard on /settings/cashback. Home-currency-locked. A 0% LOOP-asset share is the clearest nudge to pick LOOP at next checkout so cashback compounds.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: "Caller's own rail mix",
        content: {
          'application/json': { schema: UserPaymentMethodShareResponseUserSelf },
        },
      },
      400: {
        description: 'Invalid ?state',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });
}
