/**
 * Admin asset-drift watcher-state OpenAPI registration
 * (ADR 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin-treasury-assets.ts`
 * so the in-memory drift-watcher snapshot path sits alongside its
 * two locally-scoped schemas, separate from the per-asset
 * circulation read + treasury snapshot in the parent file:
 *
 *   - GET /api/admin/asset-drift/state
 *
 * Distinct from `/api/admin/assets/{assetCode}/circulation` (parent
 * file): that one forces a fresh Horizon read; this one returns
 * the background watcher's last-pass per-asset state and is cheap
 * enough to poll from the admin landing (120/min vs 30/min on
 * the Horizon-bound sibling).
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `AssetDriftStateRow`
 *   - `AssetDriftStateResponse`
 *
 * `loopAssetCode` is registered upstream in openapi.ts (also
 * used across multiple sections); threaded in as a parameter so
 * every consumer keeps the same registered component instance.
 *
 * Re-invoked from `registerAdminTreasuryAssetsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/asset-drift/state` plus its two locally-
 * scoped schemas on the supplied registry.
 */
export function registerAdminAssetDriftStateOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
): void {
  const LoopAssetCode = loopAssetCode;

  const AssetDriftStateRow = registry.register(
    'AssetDriftStateRow',
    z.object({
      assetCode: LoopAssetCode,
      state: z.enum(['unknown', 'ok', 'over']).openapi({
        description:
          "`unknown` = watcher hasn't read this asset yet (fresh boot / issuer unconfigured); `ok` = within threshold on last successful tick; `over` = outside threshold.",
      }),
      lastDriftStroops: z.string().nullable().openapi({
        description:
          'Last drift in stroops (bigint-as-string). Null until the first successful read.',
      }),
      lastThresholdStroops: z.string().nullable(),
      lastCheckedMs: z.number().int().nullable(),
      failedRowsState: z.enum(['unknown', 'none', 'present']).openapi({
        description:
          "Failed money-movement dimension (hardening A2): `present` = terminally-failed burn / interest-mint payout rows exist for this asset and need an operator retry (they are counted into the drift equation, so drift alone can't surface them); `none` = no failed rows; `unknown` = no successful watcher read yet.",
      }),
      failedBurnStroops: z.string().nullable().openapi({
        description:
          "Stroops on `kind='burn'` rows in state `failed` (bigint-as-string). Null pre-first-read.",
      }),
      failedInterestMintStroops: z.string().nullable().openapi({
        description:
          "Stroops on `kind='interest_mint'` rows in state `failed` (bigint-as-string). Null pre-first-read.",
      }),
    }),
  );

  const AssetDriftStateResponse = registry.register(
    'AssetDriftStateResponse',
    z.object({
      lastTickMs: z.number().int().nullable().openapi({
        description: 'Unix ms of the last full watcher pass. Null when the watcher never ran.',
      }),
      running: z.boolean(),
      perAsset: z.array(AssetDriftStateRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/asset-drift/state',
    summary: 'Persisted snapshot of the asset-drift watcher (ADR 015).',
    description:
      "Surfaces the background drift watcher's last-pass per-asset state (persisted in `asset_drift_state`, fleet-consistent) without forcing a fresh Horizon read. `running: false` means the watcher is not active in this process (no LOOP issuers configured or `LOOP_WORKERS_ENABLED=false`). `perAsset[].state` is `unknown` until the first successful per-asset tick. `perAsset[].failedRowsState = 'present'` flags terminally-failed burn / interest-mint rows needing an operator retry. Cheap enough to poll from the admin landing (120/min rate limit).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Watcher state snapshot',
        content: { 'application/json': { schema: AssetDriftStateResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error — the snapshot is a Postgres read (asset_drift_state, hardening A3); a DB outage degrades this poll endpoint to 500 rather than a stack trace.',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
