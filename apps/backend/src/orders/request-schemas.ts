/**
 * A2-803 / D1 (orders slice): single source of truth for the
 * `POST /api/orders/loop` request-body shape that both the runtime
 * handler (`./loop-handler.ts`) and the OpenAPI registration
 * (`../openapi/orders-loop.ts`) consume. The spec component is
 * REGISTERED FROM this exact schema, so the two cannot drift —
 * `src/__tests__/openapi-derivation.test.ts` pins the key parity.
 *
 * (The pre-ADR-052 `CreateOrderBody` for the retired CTX-proxy
 * `POST /api/orders` lived here under the same contract; it died
 * with the legacy create path.)
 *
 * The transforms are runtime-side conveniences (BigInt coercion,
 * uppercase normalisation); zod-to-openapi documents the INPUT side
 * of a transform, which is exactly what the wire contract is.
 */
import { z } from 'zod';

/**
 * Body schema for `POST /api/orders/loop` (ADR 052 ctx-backed create).
 *
 * `amountMinor` accepts number OR digit-string so BigInt face values
 * survive JSON (JS numbers lose integer precision past 2^53); both
 * arms coerce to `bigint` for the handler.
 */
export const LoopCreateOrderBody = z.object({
  merchantId: z.string().min(1),
  amountMinor: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n, { message: 'amountMinor must be positive' }),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  cryptoCurrency: z
    .string()
    .min(1)
    .max(32)
    .transform((v) => v.toUpperCase()),
});
