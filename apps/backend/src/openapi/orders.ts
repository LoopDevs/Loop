/**
 * Orders section of the OpenAPI spec — schemas + path
 * registrations for `/api/orders/*` (legacy CTX-proxy paths) and
 * `/api/orders/loop/*` (ADR 015 Loop-native paths).
 *
 * Third per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `pagination` — registered Pagination schema (also used by
 *   the merchants section).
 *
 * The 6 endpoints + ~12 zod schemas + every per-status response
 * description preserved verbatim — generated spec is byte-
 * identical to before this slice (validated via the existing
 * 1844 backend tests).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerOrdersLoopOpenApi } from './orders-loop.js';

/**
 * Registers all `/api/orders/*` and `/api/orders/loop/*` schemas
 * + paths on the supplied registry.
 */
export function registerOrdersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  pagination: ReturnType<OpenAPIRegistry['register']>,
): void {
  const CreateOrderBody = registry.register(
    'CreateOrderBody',
    z.object({
      merchantId: z.string().min(1).max(128),
      amount: z.number().min(0.01).max(10_000).multipleOf(0.01).openapi({
        description:
          '2-decimal precision, in merchant currency. Accepted range is 0.01 – 10_000, matching the runtime CreateOrderBody schema in apps/backend/src/orders/handler.ts.',
      }),
    }),
  );

  const CreateOrderResponse = registry.register(
    'CreateOrderResponse',
    z.object({
      orderId: z.string(),
      paymentUri: z.string().openapi({
        description:
          'Stellar payment URI, e.g. web+stellar:pay?destination=...&amount=...&memo=...',
      }),
      paymentAddress: z.string(),
      xlmAmount: z.string(),
      memo: z.string(),
      expiresAt: z.number().openapi({
        description: 'Unix timestamp (seconds) — server-authoritative payment window close.',
      }),
    }),
  );

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

  // Loop-native order surface — POST/GET/GET on /api/orders/loop
  // (ADR 010 / 015). Lifted into ./orders-loop.ts; the slice carries
  // its own LoopOrderView / LoopCreateOrderBody / LoopPayment*
  // schemas. Zero schema overlap with the legacy CTX-proxy flow above.
  registerOrdersLoopOpenApi(registry, errorResponse);

  registry.registerPath({
    method: 'post',
    path: '/api/orders',
    summary: 'Create a gift card order (authenticated).',
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CreateOrderBody } } } },
    responses: {
      201: {
        description: 'Order created',
        content: { 'application/json': { schema: CreateOrderResponse } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid access token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Unknown merchant',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
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
