/**
 * Caller-scoped flywheel + rail-mix OpenAPI registrations
 * (ADR 010 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/users-cashback-drill.ts`
 * so the two `/api/users/me/*` self-view paths sit alongside their
 * two locally-scoped schemas, separate from the cashback summary
 * / by-merchant / monthly drills in the parent file:
 *
 *   - GET /api/users/me/flywheel-stats        (recycled-vs-total scalar)
 *   - GET /api/users/me/payment-method-share  (caller's rail mix)
 *
 * Both paths power the user-self surfaces on /settings/cashback —
 * the FlywheelChip and the RailMixCard — and are the user-self
 * axes (ADR-022 quartet pattern) of the per-merchant flywheel-stats
 * + payment-method-share drills. Home-currency-locked, no path
 * parameters (auth context supplies the scope).
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `UserFlywheelStats`
 *   - `UserPaymentMethodShareResponseSelf`
 *
 * Re-invoked from `registerUsersCashbackDrillOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the two caller-scoped self-view paths plus their two
 * locally-scoped schemas on the supplied registry.
 */
export function registerUsersFlywheelRailOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
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
