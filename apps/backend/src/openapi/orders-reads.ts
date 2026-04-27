/**
 * Legacy CTX-proxy order read OpenAPI registrations
 * (ADR 010).
 *
 * Lifted out of `apps/backend/src/openapi/orders.ts` so the two
 * read paths sit alongside their three locally-scoped schemas,
 * separate from the `POST /api/orders` create path + create-side
 * schemas in the parent file:
 *
 *   - GET /api/orders        (paginated list)
 *   - GET /api/orders/{id}   (single-row detail)
 *
 * Both paths return the legacy `Order` row shape from the
 * CTX-proxy flow (distinct from the loop-native `LoopOrderView`
 * in `./orders-loop-reads.ts`). The list wraps it with
 * `pagination`; the detail wraps it as `{ order }`.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `Order` (with the inline `OrderStatus` enum + the
 *     `redeemScripts` sub-shape)
 *   - `OrderListResponse`
 *   - `OrderDetailResponse`
 *
 * `pagination` is registered upstream in openapi.ts (also used
 * by the merchants section); threaded in as a parameter so both
 * consumers keep the same registered component instance.
 *
 * Re-invoked from `registerOrdersOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/orders` (list) and `/api/orders/{id}` (detail)
 * plus their three locally-scoped schemas on the supplied registry.
 */
export function registerOrdersReadsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  pagination: ReturnType<OpenAPIRegistry['register']>,
): void {
  const OrderStatus = z.enum(['pending', 'completed', 'failed', 'expired']);

  const Order = registry.register(
    'Order',
    z.object({
      id: z.string(),
      merchantId: z.string(),
      merchantName: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: OrderStatus,
      xlmAmount: z.string(),
      percentDiscount: z.string().optional(),
      redeemType: z.enum(['url', 'barcode']).optional(),
      giftCardCode: z.string().optional(),
      giftCardPin: z.string().optional(),
      redeemUrl: z.string().optional(),
      redeemChallengeCode: z.string().optional(),
      // CTX sometimes returns helper scripts for automating
      // redemption inside the WebView (inject challenge, scrape
      // result). Present in the handler response and in the
      // shared `Order` type, previously missing from the OpenAPI
      // schema — a generated client would have stripped them as
      // unknown fields.
      redeemScripts: z
        .object({
          injectChallenge: z.string().optional(),
          scrapeResult: z.string().optional(),
        })
        .optional(),
      createdAt: z.string(),
    }),
  );

  const OrderListResponse = registry.register(
    'OrderListResponse',
    z.object({ orders: z.array(Order), pagination }),
  );

  // The GET /api/orders/{id} handler wraps its result as `{ order }`
  // — see `c.json({ order })` in `apps/backend/src/orders/handler.ts`.
  // The web client (`services/orders.ts`) also consumes the wrapped
  // shape. Register the wrapper explicitly so generated OpenAPI
  // clients parse the same envelope instead of trying to unmarshal
  // the raw Order type.
  const OrderDetailResponse = registry.register('OrderDetailResponse', z.object({ order: Order }));

  registry.registerPath({
    method: 'get',
    path: '/api/orders',
    summary: 'List orders for the authenticated user.',
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: {
      // Only these three are forwarded to upstream; unknown params
      // are stripped — see `ALLOWED_LIST_QUERY_PARAMS` in
      // `orders/handler.ts`.
      query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        perPage: z.coerce.number().int().min(1).max(100).optional(),
        status: z.string().max(32).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Orders',
        content: { 'application/json': { schema: OrderListResponse } },
      },
      401: {
        description: 'Missing or invalid access token',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream error from CTX',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Circuit breaker open',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/orders/{id}',
    summary: 'Fetch a single order by id.',
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Order',
        content: { 'application/json': { schema: OrderDetailResponse } },
      },
      400: {
        description: 'Invalid order id',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid access token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream error from CTX',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Circuit breaker open',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
