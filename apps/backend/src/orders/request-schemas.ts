/**
 * A2-803 (orders slice): single source of truth for the
 * CTX-proxy `POST /api/orders` request-body shape that both the
 * runtime handler (`./handler.ts`) and the OpenAPI registration
 * (`../openapi/orders.ts`) used to declare independently.
 *
 * Before this module both files declared the same `CreateOrderBody`
 * zod object verbatim — the openapi version's own description even
 * called it out: "matching the runtime CreateOrderBody schema in
 * apps/backend/src/orders/handler.ts". A future tweak (a tighter
 * amount cap, an extra field) had to land in two places to stay
 * consistent.
 *
 * Pure zod, no `.openapi()` annotations — same posture as
 * `../auth/request-schemas.ts`. The openapi factory can layer
 * field-level metadata onto the imported schema at registration
 * time if needed; the shared definition stays runtime-friendly
 * (no dependency on `extendZodWithOpenApi(z)` having been called
 * first).
 *
 * Promotion to `@loop/shared` (so the web client can also depend
 * on the same canonical zod) is a separate Phase-2 lift —
 * `@loop/shared` is currently type-only and would need a `zod`
 * dep first.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// `extendZodWithOpenApi(z)` patches `.openapi(...)` onto every zod
// schema's prototype. It's idempotent and only mutates the prototype
// — calling it from this module ensures the schema below carries
// `.openapi` even when this module loads before the openapi entry
// point's own `extendZodWithOpenApi(z)` call (the registration in
// `../openapi.ts` runs `extendZodWithOpenApi` AFTER importing this
// file via the orders openapi factory, so the schema-creation here
// would otherwise predate the extension).
extendZodWithOpenApi(z);

/**
 * Body schema for `POST /api/orders` (CTX-proxy create).
 *
 * `.finite().positive()` are implied by `.min(0.01).max(10_000)` —
 * Number ranges exclude Infinity / NaN once `.min` is set. The
 * `.multipleOf(0.01)` guard enforces cents-precision so we never
 * send IEEE-754 garbage (`0.1 + 0.2 = 0.30000000000000004`) to
 * upstream.
 */
export const CreateOrderBody = z.object({
  merchantId: z.string().min(1).max(128),
  amount: z.number().min(0.01).max(10_000).multipleOf(0.01),
});
