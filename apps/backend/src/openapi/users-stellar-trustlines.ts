/**
 * Caller-scoped Stellar-trustline OpenAPI registration (ADR 015).
 *
 * Lifted out of `apps/backend/src/openapi/users-profile.ts` so the
 * Horizon-side trustline-check path sits alongside its two
 * locally-scoped schemas, separate from the profile / linked-wallet
 * mutation paths in the parent file:
 *
 *   - GET /api/users/me/stellar-trustlines
 *
 * The path is the wallet UI's "is your account ready for a USDLOOP
 * payout?" probe — it reads the caller's linked address against
 * Horizon and reports which configured LOOP assets already have a
 * trustline. Distinct from the profile-mutation paths above (which
 * write to the users row) — this one is purely a read-through to
 * Horizon, with a 30s cache and a 503 response code unique to the
 * trustlines surface.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `StellarTrustlineRow`
 *   - `StellarTrustlinesResponse`
 *
 * `loopAssetCode` is registered upstream in openapi.ts (also used
 * by other Users / Admin sections); threaded in as a parameter so
 * every consumer keeps the same registered component instance.
 *
 * Re-invoked from `registerUsersProfileOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/users/me/stellar-trustlines` plus its two
 * locally-scoped schemas on the supplied registry.
 */
export function registerUsersStellarTrustlinesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
): void {
  const StellarTrustlineRow = registry.register(
    'StellarTrustlineRow',
    z.object({
      code: loopAssetCode,
      issuer: z.string(),
      present: z.boolean(),
      balanceStroops: z.string(),
      limitStroops: z.string(),
    }),
  );

  const StellarTrustlinesResponse = registry.register(
    'StellarTrustlinesResponse',
    z.object({
      address: z.string().nullable(),
      accountLinked: z.boolean(),
      accountExists: z.boolean(),
      rows: z.array(StellarTrustlineRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/stellar-trustlines',
    summary: 'Caller-scoped LOOP-asset trustline check (ADR 015).',
    description:
      "Reads the caller's linked Stellar address on Horizon and reports which configured LOOP assets already have a trustline established. Lets the wallet UI warn 'your next USDLOOP payout will fail — add the trustline first' rather than surfacing a `op_no_trust` failed payout after the fact. Returns `accountLinked: false` with stub rows when the user hasn't linked a wallet; `accountExists: false` when the address isn't funded yet. 30s cache per address.",
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per configured LOOP asset',
        content: { 'application/json': { schema: StellarTrustlinesResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Horizon trustline check unavailable',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
