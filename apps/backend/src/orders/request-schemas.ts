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
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// `extendZodWithOpenApi(z)` patches `.openapi(...)` onto every zod
// schema's prototype. It's idempotent and only mutates the prototype
// — calling it from this module ensures the schema below carries
// `.openapi` even when this module loads before the openapi entry
// point's own `extendZodWithOpenApi(z)` call.
extendZodWithOpenApi(z);

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
    .refine((v) => v > 0n, { message: 'amountMinor must be positive' })
    .openapi({
      description:
        'Gift-card face value in the catalog currency, minor units. Number OR digit-string so BigInt values survive the wire.',
    }),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase())
    .openapi({
      description:
        'Gift-card catalog currency — ISO 4217 three-letter code, uppercase. One of the home currencies (USD/GBP/EUR) or an ADR-035 extended display market (AED/INR/SAR/AUD/MXN).',
    }),
  cryptoCurrency: z
    .string()
    .min(1)
    .max(32)
    .transform((v) => v.toUpperCase())
    .openapi({
      description:
        'Chain-qualified CTX payment currency the customer chose (e.g. XLM, DASH, ETH.USDT). Validated against the server allowlist (`GET /api/config` → ctxPaymentCurrencies).',
    }),
});
