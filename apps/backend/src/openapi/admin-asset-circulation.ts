/**
 * Admin per-asset circulation drift OpenAPI registration
 * (ADR 015 stablecoin-safety surface).
 *
 * Lifted out of `./admin-treasury-assets.ts`. The circulation
 * endpoint compares Horizon-side issued circulation against the
 * off-chain ledger liability for one LOOP asset — the actionable
 * per-asset drift signal that pairs with the watcher-state surface
 * already in `./admin-asset-drift-state.ts`. Pulling it out leaves
 * the parent file focused on the read-optimised treasury snapshot.
 *
 * Path in the slice:
 *   - GET /api/admin/assets/{assetCode}/circulation
 *
 * One locally-scoped registered schema travels with it:
 *   - `AssetCirculationResponse`
 *
 * Two deps cross the boundary:
 *   - `errorResponse` (shared component from openapi.ts)
 *   - `loopAssetCode` — same threading pattern as the parent's
 *     other consumers (treasury snapshot + drift-state sibling).
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

type ZodEnumLike = z.ZodEnum<{ readonly [key: string]: string | number }>;

/**
 * Registers the per-asset circulation path + its locally-scoped
 * schema on the supplied registry. Called once from
 * `registerAdminTreasuryAssetsOpenApi`.
 */
export function registerAdminAssetCirculationOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: ZodEnumLike,
): void {
  const LoopAssetCode = loopAssetCode;

  const AssetCirculationResponse = registry.register(
    'AssetCirculationResponse',
    z.object({
      assetCode: LoopAssetCode,
      fiatCurrency: z.enum(['USD', 'GBP', 'EUR']),
      issuer: z.string(),
      onChainStroops: z.string().openapi({
        description:
          'Horizon-issued circulation for (assetCode, issuer). bigint-as-string stroops.',
      }),
      ledgerLiabilityMinor: z.string().openapi({
        description:
          'Sum of user_credits.balance_minor for the matching fiat. bigint-as-string minor units.',
      }),
      driftStroops: z.string().openapi({
        description:
          'onChainStroops - ledgerLiabilityMinor × 1e5 (1 minor = 1e5 stroops for a 1:1-pinned LOOP asset). Positive = over-minted; negative = settlement backlog.',
      }),
      onChainAsOfMs: z.number().int(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/assets/{assetCode}/circulation',
    summary: 'Per-asset circulation drift — stablecoin safety metric (ADR 015).',
    description:
      'Compares Horizon-side issued circulation (via `/assets?asset_code=X&asset_issuer=Y`) against the off-chain ledger liability (`user_credits.balance_minor` for the matching fiat). `driftStroops = onChainStroops - ledgerLiabilityMinor × 1e5` — positive drift means over-minted (investigate now), negative means settlement backlog (expected as the payout worker catches up). Horizon failures surface as 503 rather than 500 so the admin UI keeps the ledger side authoritative. Missing issuer env → 409. 30/min rate limit; Horizon calls cached 30s internally.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ assetCode: LoopAssetCode }),
    },
    responses: {
      200: {
        description: 'Drift snapshot',
        content: { 'application/json': { schema: AssetCirculationResponse } },
      },
      400: {
        description: 'Unknown `assetCode`',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Issuer env not configured for this asset',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading ledger liability',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Horizon circulation read failed',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
