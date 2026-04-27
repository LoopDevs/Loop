/**
 * Loop-native `/api/orders/loop/*` OpenAPI registrations
 * (ADR 010 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/orders.ts` to separate
 * the loop-native flow (POST/GET/GET on `/api/orders/loop`) from
 * the legacy CTX-proxy flow (POST/GET/GET on `/api/orders`). The
 * two surfaces share zero locally-scoped schemas — every legacy
 * schema is `Order` / `CreateOrderBody` etc., every loop-native
 * schema is `LoopOrderView` / `LoopCreateOrderBody` /
 * `LoopPayment*` — so the slice boundary is naturally clean.
 *
 * Schemas in this slice:
 *   - `LoopPaymentMethod` enum (xlm / usdc / credit / loop_asset)
 *   - `LoopCreateOrderBody`
 *   - `LoopPaymentStellar` / `LoopPaymentLoopAsset` /
 *     `LoopPaymentCredit` (per-method instruction shapes; inline,
 *     not registered — composed into `LoopCreateOrderResponse`)
 *   - `LoopCreateOrderResponse`
 *   - `LoopOrderView`
 *   - `LoopOrderListResponse`
 *
 * Three paths:
 *   - POST /api/orders/loop          (create)
 *   - GET  /api/orders/loop          (paginated list)
 *   - GET  /api/orders/loop/{id}     (single drill)
 *
 * Only `errorResponse` crosses the slice boundary — the loop list
 * endpoint uses `?limit=` + `?before=<iso>` cursor pagination, not
 * the registered `Pagination` schema that the legacy /api/orders
 * list relies on.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerOrdersLoopReadsOpenApi } from './orders-loop-reads.js';

/**
 * Registers the Loop-native `/api/orders/loop/*` schemas + paths
 * on the supplied registry. Called once from `registerOrdersOpenApi`.
 */
export function registerOrdersLoopOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // A2-662 / A2-1504 — Loop-native order surface (POST
  // /api/orders/loop, GET /api/orders/loop, GET
  // /api/orders/loop/:id). These replace the legacy CTX-proxy
  // order flow for Loop-auth users; they cover all four payment
  // methods (xlm, usdc, credit, loop_asset) plus the cashback-
  // recycling paths from ADR 015. Schemas mirror the runtime
  // shapes declared in `apps/backend/src/orders/loop-handler.ts`.
  const LoopPaymentMethod = registry.register(
    'LoopPaymentMethod',
    z.enum(['xlm', 'usdc', 'credit', 'loop_asset']),
  );

  const LoopCreateOrderBody = registry.register(
    'LoopCreateOrderBody',
    z.object({
      merchantId: z.string().min(1),
      amountMinor: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).openapi({
        description:
          'Gift-card face value in the catalog currency, minor units. Number OR digit-string so BigInt values survive the wire.',
      }),
      currency: z
        .string()
        .length(3)
        .openapi({ description: 'ISO 4217 three-letter code, uppercase.' }),
      paymentMethod: LoopPaymentMethod,
    }),
  );

  // Per-method payment-instruction shape returned by `POST
  // /api/orders/loop`. On-chain methods (xlm / usdc / loop_asset)
  // return the Stellar address, memo, and amount the client needs
  // to construct the outbound payment; credit orders return only
  // the amount we'll debit from the user's cashback balance (the
  // debit itself happens later, on the paid-state transition,
  // per orders/repo.ts A2-601).
  const LoopPaymentStellar = z.object({
    method: z.enum(['xlm', 'usdc']),
    stellarAddress: z.string(),
    memo: z.string(),
    amountMinor: z.string(),
    currency: z.string(),
  });

  const LoopPaymentLoopAsset = z.object({
    method: z.literal('loop_asset'),
    stellarAddress: z.string(),
    memo: z.string(),
    amountMinor: z.string(),
    currency: z.string(),
    assetCode: z.enum(['USDLOOP', 'GBPLOOP', 'EURLOOP']).openapi({
      description: 'LOOP-branded stablecoin the user pays in — pinned to their home currency.',
    }),
    assetIssuer: z.string(),
  });

  const LoopPaymentCredit = z.object({
    method: z.literal('credit'),
    amountMinor: z.string(),
    currency: z.string(),
  });

  const LoopCreateOrderResponse = registry.register(
    'LoopCreateOrderResponse',
    z.object({
      orderId: z.string().uuid(),
      payment: z.union([LoopPaymentStellar, LoopPaymentLoopAsset, LoopPaymentCredit]),
    }),
  );

  // `LoopOrderView` and `LoopOrderListResponse`, plus the two
  // read paths that use them, live in `./orders-loop-reads.ts`.
  // Registered after the create path below so OpenAPI
  // path-registration order is preserved.

  // A2-662 / A2-1504: Loop-native order surface (ADR 015). Gated
  // on LOOP_AUTH_NATIVE_ENABLED + a Loop-kind auth context —
  // returns 404 to callers not on the Loop-auth path so the
  // surface isn't observable from the legacy CTX-proxy bearer
  // path.
  registry.registerPath({
    method: 'post',
    path: '/api/orders/loop',
    summary: 'Create a Loop-native order (ADR 015).',
    description:
      "Creates an order under the Loop-native auth path. Returns per-method payment instructions: on-chain methods (`xlm`, `usdc`, `loop_asset`) include the destination address + memo the client uses to build the outbound payment; `credit` returns only the amount we'll debit from the user's cashback balance on the paid-state transition. Optional `Idempotency-Key` header (16-128 chars) — when present, a repeat post replays the prior order's response instead of creating a duplicate (A2-2003).",
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: {
      headers: z.object({
        'Idempotency-Key': z
          .string()
          .min(16)
          .max(128)
          .optional()
          .describe(
            'A2-2003: client-supplied de-dup key. When present, scoped per-user and unique per order. A repeat POST with the same key returns the original order rather than creating a duplicate.',
          ),
      }),
      body: { content: { 'application/json': { schema: LoopCreateOrderBody } } },
    },
    responses: {
      200: {
        description: 'Order created — payment instructions returned per method',
        content: { 'application/json': { schema: LoopCreateOrderResponse } },
      },
      400: {
        description:
          'Validation error or unknown/disabled merchant (also: malformed Idempotency-Key length)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or non-Loop auth context',
        content: { 'application/json': { schema: errorResponse } },
      },
      402: {
        description: 'Credit-funded order with insufficient balance',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Loop-native auth disabled (LOOP_AUTH_NATIVE_ENABLED=false)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Invalid account currency or unexpected server error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The two Loop-native order read paths (list + detail) live in
  // `./orders-loop-reads.ts` along with their `LoopOrderView` /
  // `LoopOrderListResponse` schemas. Same path-registration
  // position as the original block.
  registerOrdersLoopReadsOpenApi(registry, errorResponse);
}
