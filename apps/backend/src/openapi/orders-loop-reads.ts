/**
 * Loop order read OpenAPI registrations (ADR 052).
 *
 * Lifted out of `apps/backend/src/openapi/orders-loop.ts` so the
 * two read paths sit alongside their two locally-scoped schemas,
 * separate from the create path + create-side schemas in the
 * parent file:
 *
 *   - GET /api/orders/loop        (newest-first cursor-paged list)
 *   - GET /api/orders/loop/{id}   (single-order detail)
 *
 * Both paths return a `LoopOrderView`-shaped row (the list wraps
 * it in a `{ orders: [] }` envelope). Same auth + 404-on-non-owner
 * convention. Same `LOOP_AUTH_NATIVE_ENABLED` gate.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `LoopOrderView`
 *   - `LoopOrderListResponse`
 *
 * Re-invoked from `registerOrdersLoopOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/orders/loop` (list) and `/api/orders/loop/{id}`
 * (detail) plus their two locally-scoped schemas on the supplied
 * registry.
 */
export function registerOrdersLoopReadsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const LoopOrderView = registry.register(
    'LoopOrderView',
    z.object({
      id: z.string().uuid(),
      merchantId: z.string(),
      state: z.string().openapi({
        description:
          'Mirror of CTX displayStatus — unpaid, paid, fulfilled, rejected, refunded, expired (ADR 052).',
      }),
      faceValueMinor: z.string().openapi({
        description: 'Gift-card face value, catalog currency, minor units. BigInt as string.',
      }),
      currency: z.string(),
      chargeMinor: z.string().openapi({
        description: 'What the customer pays CTX (face value minus the cashback discount).',
      }),
      chargeCurrency: z.string(),
      userCashbackMinor: z.string().openapi({
        description: 'Cashback CTX applied as a checkout discount. Minor units, bigint-string.',
      }),
      ctxOrderId: z.string().nullable(),
      paymentCryptoCurrency: z.string().nullable().openapi({
        description: 'Chain-qualified CTX payment currency chosen at create. Null on legacy rows.',
      }),
      payment: z
        .object({
          ctxPaymentId: z.string().nullable(),
          cryptoCurrency: z.string(),
          cryptoAmount: z.string().nullable(),
          address: z.string().nullable(),
          paymentUrls: z.record(z.string(), z.string()),
          amountMinor: z.string(),
          currency: z.string(),
          expiresAt: z.string().datetime().nullable(),
        })
        .nullable()
        .openapi({
          description:
            'CTX payment instructions — non-null only while the order is `unpaid` on the detail read, so the pay screen is fully server-rebuildable.',
        }),
      redeemCode: z.string().nullable(),
      redeemPin: z.string().nullable(),
      redeemUrl: z.string().nullable(),
      failureReason: z.string().nullable(),
      createdAt: z.string().datetime(),
      fulfilledAt: z.string().datetime().nullable(),
      failedAt: z.string().datetime().nullable(),
    }),
  );

  const LoopOrderListResponse = registry.register(
    'LoopOrderListResponse',
    z.object({ orders: z.array(LoopOrderView) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/orders/loop',
    summary: "List the caller's Loop-native orders (newest first, cursor-paged).",
    description:
      "Descending by `created_at`. Optional `?limit=` (1-100, default 50) and `?before=<iso>` for pagination — pass the last row's createdAt to page backwards. Returns `{ orders: [] }` for fresh accounts.",
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Order list',
        content: { 'application/json': { schema: LoopOrderListResponse } },
      },
      400: {
        description: 'Invalid `before` timestamp',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or non-Loop auth context',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Loop-native auth disabled',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/orders/loop/{id}',
    summary: 'Fetch a single Loop-native order the caller owns.',
    description:
      '404 on non-owner reads so an attacker cannot enumerate order ids — every order belongs to exactly one Loop user, keyed on the JWT `sub`.',
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Order',
        content: { 'application/json': { schema: LoopOrderView } },
      },
      400: {
        description: 'Invalid id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or non-Loop auth context',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Loop-native auth disabled OR order not found / not owned by caller',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
