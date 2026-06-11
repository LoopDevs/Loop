/**
 * `POST /api/orders/loop/{id}/pay-with-balance` registration
 * (ADR 030 Phase C3 / ADR 036).
 *
 * Server-orchestrated LOOP-asset redemption: the backend builds the
 * payment from the user's embedded wallet to the deposit address,
 * collects the provider signature, fee-bumps it from the operator
 * account, and submits. Downstream the existing payment watcher /
 * mirror-debit / issuer-burn pipeline applies unchanged.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerOrdersPayWithBalanceOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const PayWithBalanceResponse = registry.register(
    'PayWithBalanceResponse',
    z.object({
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled']).openapi({
        description:
          'Order state after the submit. Usually still `pending_payment` — the payment watcher flips it to `paid` when it matches the memo on the next tick; the client keeps polling `GET /api/orders/loop/:id` exactly as for manual crypto payments. Already-paid orders replay their state idempotently.',
      }),
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/orders/loop/{id}/pay-with-balance',
    summary: 'Pay a loop_asset order from the embedded-wallet balance (ADR 030 C3).',
    description:
      "One-tap redemption: builds a LOOP-asset payment from the caller's embedded wallet to the Loop deposit address carrying the order's payment memo, signs it via the wallet provider, wraps it in an operator fee-bump (the wallet holds zero XLM), and submits to Horizon. Idempotent per order — already-paid orders return 200 with their current state; a concurrent in-flight call is fenced with 400 `PAYMENT_IN_FLIGHT`. Downstream settlement (mirror debit + issuer-return burn, ADR 036) is driven by the payment watcher, not this endpoint.",
    tags: ['Orders'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payment submitted (or already landed) — current order state',
        content: { 'application/json': { schema: PayWithBalanceResponse } },
      },
      400: {
        description:
          'Non-uuid id (`VALIDATION_ERROR`), order not payable — wrong method or terminal state (`ORDER_NOT_PAYABLE`), wallet not provisioned/activated (`WALLET_NOT_ACTIVATED`), concurrent call in flight (`PAYMENT_IN_FLIGHT`), or on-chain balance below the charge (`INSUFFICIENT_BALANCE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or non-Loop auth context',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Loop-native auth disabled (LOOP_AUTH_NATIVE_ENABLED=false), or the order does not exist / is not owned by the caller',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Terminal wallet-provider or Horizon submit failure (`INTERNAL_ERROR`), or a loop_asset order missing its payment memo',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'Embedded wallet or LOOP issuer not configured (`NOT_CONFIGURED`), Horizon/provider temporarily unavailable (`SERVICE_UNAVAILABLE`), or the `orders-loop` kill switch is engaged (`SUBSYSTEM_DISABLED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
