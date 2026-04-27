/**
 * Admin treasury / asset-drift OpenAPI registrations
 * (ADR 009 / 011 / 013 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Three paths
 * that read together as the ADR-015 ledger ↔ chain reconciliation
 * surface: the treasury snapshot, the per-asset circulation drift,
 * and the in-memory drift watcher state.
 *
 * Path registered directly here:
 *   - GET /api/admin/treasury
 *
 * Paths delegated to sibling slices:
 *   - GET /api/admin/assets/{assetCode}/circulation —
 *     `./admin-asset-circulation.ts` (owns
 *     `AssetCirculationResponse`)
 *   - GET /api/admin/asset-drift/state —
 *     `./admin-asset-drift-state.ts` (owns
 *     `AssetDriftStateRow` + `AssetDriftStateResponse`)
 *
 * Schemas registered directly here:
 *
 *   - inline `LoopLiability`, `TreasuryHolding`, `TreasuryOrderFlow`,
 *     `OperatorHealthEntry` (NOT registered — composed into
 *     `TreasurySnapshot` only)
 *   - registered: `TreasurySnapshot`
 *
 * Three deps cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts)
 *   - `LoopAssetCode` — cross-section enum, also used by Users
 *     (LOOP-asset code is the asset-side identifier across the
 *     whole stablecoin topology).
 *   - `PayoutState` — cross-section enum, used by `TreasurySnapshot`
 *     for the per-state payout count map.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminAssetDriftStateOpenApi } from './admin-asset-drift-state.js';
import { registerAdminAssetCirculationOpenApi } from './admin-asset-circulation.js';

type ZodEnumLike = z.ZodEnum<{ readonly [key: string]: string | number }>;

/**
 * Registers the treasury / asset-drift paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminTreasuryAssetsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: ZodEnumLike,
  payoutState: ZodEnumLike,
): void {
  // Local aliases keep the body syntactically identical to the
  // pre-decomposition source.
  const LoopAssetCode = loopAssetCode;
  const PayoutState = payoutState;

  // ─── Admin (ADR 015 — treasury + payouts) ───────────────────────────────────

  const LoopLiability = z.object({
    outstandingMinor: z.string().openapi({
      description:
        'Outstanding claim in the matching fiat minor units (cents / pence). BigInt as string.',
    }),
    issuer: z.string().nullable().openapi({
      description: 'Stellar issuer account pinned by env for this asset; null when unconfigured.',
    }),
  });

  const TreasuryHolding = z.object({
    stroops: z.string().nullable().openapi({
      description:
        'Live on-chain balance in stroops (7 decimals). Null when the operator account is unset or Horizon is temporarily unreachable.',
    }),
  });

  const TreasuryOrderFlow = z.object({
    count: z.string().openapi({
      description:
        'Number of fulfilled orders in this charge-currency bucket. BigInt-string count.',
    }),
    faceValueMinor: z.string().openapi({
      description:
        'Sum of gift-card face values (minor units of the charge currency). BigInt-string.',
    }),
    wholesaleMinor: z.string().openapi({
      description: 'Total paid to CTX (supplier) for this bucket. Minor units, bigint-string.',
    }),
    userCashbackMinor: z.string().openapi({
      description: 'Total cashback credited to users for this bucket. Minor units, bigint-string.',
    }),
    loopMarginMinor: z.string().openapi({
      description: 'Total kept by Loop for this bucket. Minor units, bigint-string.',
    }),
  });

  const OperatorHealthEntry = z.object({
    id: z.string(),
    state: z.string().openapi({
      description: 'Circuit state for this operator (closed / half_open / open).',
    }),
  });

  const TreasurySnapshot = registry.register(
    'TreasurySnapshot',
    z.object({
      outstanding: z.record(z.string(), z.string()).openapi({
        description: 'Sum of user_credits.balance_minor per currency, as bigint-strings.',
      }),
      totals: z.record(z.string(), z.record(z.string(), z.string())).openapi({
        description: 'Sum of credit_transactions.amount_minor grouped by (currency, type).',
      }),
      liabilities: z.record(LoopAssetCode, LoopLiability).openapi({
        description:
          'ADR 015 — per LOOP asset, the outstanding user claim + the configured issuer. Stable shape across all three codes.',
      }),
      assets: z.object({
        USDC: TreasuryHolding,
        XLM: TreasuryHolding,
      }),
      payouts: z.record(PayoutState, z.string()).openapi({
        description:
          'ADR 015 — pending_payouts row counts per state. Always returns an entry for each state (zero when empty).',
      }),
      orderFlows: z.record(z.string(), TreasuryOrderFlow).openapi({
        description:
          'ADR 015 — aggregated economics of fulfilled orders, keyed by charge currency. Surfaces the CTX-supplier split (wholesale / user cashback / Loop margin).',
      }),
      operatorPool: z.object({
        size: z.number().int(),
        operators: z.array(OperatorHealthEntry),
      }),
    }),
  );

  // `AssetDriftStateRow` and `AssetDriftStateResponse`, plus the
  // `/api/admin/asset-drift/state` path that uses them, live in
  // `./admin-asset-drift-state.ts`. Registered after the two
  // Horizon-bound paths below so OpenAPI path-registration order
  // is preserved.

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury',
    summary: 'Admin treasury snapshot (ADR 009 / 011 / 015).',
    description:
      "Single read-optimised aggregate the admin UI renders without running its own SQL. Covers the credit-ledger outstanding + totals (ADR 009), LOOP-asset liabilities keyed by asset code (ADR 015), Loop's own USDC / XLM holdings, pending-payouts counts per state, and the CTX operator-pool health snapshot (ADR 013). Horizon failures don't 500 this surface — liability counts are authoritative from Postgres; assets fall back to null-stroops when the balance read fails.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Snapshot',
        content: { 'application/json': { schema: TreasurySnapshot } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — per-asset circulation drift (ADR 015) ─────────────────────────
  //
  // Path + locally-scoped `AssetCirculationResponse` schema live
  // in `./admin-asset-circulation.ts`. Threaded with
  // `errorResponse` + `LoopAssetCode` so the registered enum
  // instance is shared across the treasury / circulation /
  // drift-state surface.
  registerAdminAssetCirculationOpenApi(registry, errorResponse, LoopAssetCode);

  // The asset-drift watcher-state path lives in
  // `./admin-asset-drift-state.ts` along with its two
  // locally-scoped schemas. Same path-registration position as
  // the original block.
  registerAdminAssetDriftStateOpenApi(registry, errorResponse, LoopAssetCode);
}
