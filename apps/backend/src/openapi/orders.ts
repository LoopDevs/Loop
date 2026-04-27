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
import { registerOrdersReadsOpenApi } from './orders-reads.js';

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

  // The two CTX-proxy read paths (list + detail) and their three
  // locally-scoped schemas (`Order`, `OrderListResponse`,
  // `OrderDetailResponse`) live in `./orders-reads.ts`. Same
  // path-registration position as the original block.

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

  // The CTX-proxy read paths (list + detail) live in
  // `./orders-reads.ts` along with their three locally-scoped
  // schemas. Registered after the create path above so OpenAPI
  // path-registration order is preserved.
  registerOrdersReadsOpenApi(registry, errorResponse, pagination);
}
