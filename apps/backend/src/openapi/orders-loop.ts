/**
 * Loop `/api/orders/loop/*` OpenAPI registrations (ADR 052).
 *
 * ctx is the payment processor: the create path relays CTX's own
 * payment instructions (address / payment URIs / crypto amount) and
 * the read paths mirror CTX's `displayStatus`. Schemas mirror the
 * wire types in `@loop/shared/loop-orders.ts`.
 *
 * Schemas in this slice:
 *   - `LoopCreateOrderBody`
 *   - `LoopOrderPaymentInstructions`
 *   - `LoopCreateOrderResponse`
 *   - `LoopOrderView` / `LoopOrderListResponse` (reads slice)
 *
 * Three paths:
 *   - POST /api/orders/loop          (create)
 *   - GET  /api/orders/loop          (paginated list)
 *   - GET  /api/orders/loop/{id}     (single drill)
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { LoopCreateOrderBody } from '../orders/request-schemas.js';
import { registerOrdersLoopReadsOpenApi } from './orders-loop-reads.js';

/**
 * Registers the Loop `/api/orders/loop/*` schemas + paths on the
 * supplied registry. Called once from `registerOrdersOpenApi`.
 */
export function registerOrdersLoopOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // D1: registered FROM the exact schema `loop-handler.ts` parses —
  // see `../orders/request-schemas.ts`; key parity is pinned by
  // `src/__tests__/openapi-derivation.test.ts`.
  const registeredLoopCreateOrderBody = registry.register(
    'LoopCreateOrderBody',
    LoopCreateOrderBody,
  );

  const LoopOrderPaymentInstructions = registry.register(
    'LoopOrderPaymentInstructions',
    z.object({
      ctxPaymentId: z.string().nullable(),
      cryptoCurrency: z.string(),
      cryptoAmount: z.string().nullable().openapi({
        description: 'Amount to send in the crypto currency major units (decimal string).',
      }),
      address: z.string().nullable().openapi({
        description: "CTX's deposit address for the chosen currency, when a single one applies.",
      }),
      paymentUrls: z.record(z.string(), z.string()).openapi({
        description:
          'Per-currency payment URIs from CTX (BIP70 dash:?r=, SEP-7 web+stellar:pay, ethereum:, solana:, ...). May be empty for address-only chains.',
      }),
      amountMinor: z.string().openapi({
        description: 'What the customer pays CTX (face value minus cashback discount).',
      }),
      currency: z.string(),
      expiresAt: z.string().datetime().nullable().openapi({
        description: 'CTX payment-window expiry; null when the payment read was unavailable.',
      }),
    }),
  );

  const LoopCreateOrderResponse = registry.register(
    'LoopCreateOrderResponse',
    z.object({
      orderId: z.string().uuid(),
      state: z.string().openapi({
        description:
          'Mirror of CTX displayStatus — unpaid, paid, fulfilled, rejected, refunded, expired.',
      }),
      payment: LoopOrderPaymentInstructions,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/orders/loop',
    summary: 'Create a Loop order — CTX handles the payment (ADR 052).',
    description:
      "Creates the gift card at CTX acting-as the caller and relays CTX's payment instructions. The customer pays CTX directly; Loop mirrors the card's status thereafter. Requires a trusted `X-Client-Id` (loopweb / loopios / loopandroid) so CTX attributes the purchase to the originating platform. Optional `Idempotency-Key` header (16-128 chars) — a repeat post replays the prior order's response instead of creating a duplicate (A2-2003).",
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
            'A2-2003: client-supplied de-dup key, scoped per-user. A repeat POST with the same key returns the original order rather than creating a duplicate.',
          ),
        'X-Client-Id': z
          .string()
          .describe('Originating platform client id — loopweb / loopios / loopandroid. Required.'),
      }),
      body: { content: { 'application/json': { schema: registeredLoopCreateOrderBody } } },
    },
    responses: {
      201: {
        description: 'Order created — CTX payment instructions returned',
        content: { 'application/json': { schema: LoopCreateOrderResponse } },
      },
      200: {
        description: 'Idempotent replay of a previously-created order',
        content: { 'application/json': { schema: LoopCreateOrderResponse } },
      },
      400: {
        description:
          'Validation error (unknown/disabled merchant, denomination out of range, cryptoCurrency not in the allowlist, missing X-Client-Id, malformed Idempotency-Key length), or the supplier rejected the create',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or non-Loop auth context',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Loop-native auth disabled (LOOP_AUTH_NATIVE_ENABLED=false)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description:
          'Rate limit exceeded (10/min per IP), or ORDER_VELOCITY_EXCEEDED (ADR 045 / B-3) — per-user rolling-window order count/value cap.',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Unexpected server error',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'SUPPLIER_UNAVAILABLE (CTX unreachable / rate-limited / schema drift), SERVICE_UNAVAILABLE (CTX customer provisioning pending or operator credentials unset), or ORDER_VELOCITY_CHECK_UNAVAILABLE (fails closed, no order created)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The two Loop order read paths (list + detail) live in
  // `./orders-loop-reads.ts` along with their `LoopOrderView` /
  // `LoopOrderListResponse` schemas.
  registerOrdersLoopReadsOpenApi(registry, errorResponse);
}
