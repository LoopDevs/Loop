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
import { registerAdminInterestMintForecastOpenApi } from './admin-interest-mint-forecast.js';

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

  const OperatorFloatState = z.object({
    state: z.enum(['ok', 'drift', 'unclassified', 'needs_baseline', 'error', 'unknown']),
    expectedBalanceStroops: z.string().nullable(),
    actualBalanceStroops: z.string().nullable(),
    deltaStroops: z.string().nullable(),
    thresholdStroops: z.string().nullable(),
    unclassifiedCount: z.number().int(),
    checkedAt: z.string().nullable(),
    error: z.string().nullable(),
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
      operatorFloat: z.object({
        xlm: OperatorFloatState,
        usdc: OperatorFloatState,
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

  const OperatorFloatMovement = registry.register(
    'OperatorFloatMovement',
    z.object({
      paymentId: z.string(),
      txHash: z.string(),
      asset: z.enum(['xlm', 'usdc']),
      direction: z.enum(['in', 'out']),
      amountStroops: z.string(),
      classification: z.string(),
      fromAddress: z.string().nullable(),
      toAddress: z.string().nullable(),
      memoText: z.string().nullable(),
      observedAt: z.string(),
    }),
  );

  const OperatorFloatAdminWriteAudit = z.object({
    actorUserId: z.string().uuid(),
    actorEmail: z.string().email().nullable(),
    idempotencyKey: z.string(),
    appliedAt: z.string().datetime(),
    replayed: z.boolean(),
  });

  const OperatorFloatBaselineBody = registry.register(
    'OperatorFloatBaselineBody',
    z.object({
      asset: z.enum(['xlm', 'usdc']),
      account: z.string().min(10).max(128),
      openingBalanceStroops: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description:
            'Non-negative operator-wallet opening balance at the reconciliation start cursor, in stroops.',
        }),
      startingHorizonCursor: z.string().min(1).max(200).openapi({
        description:
          'Required Horizon paging cursor where reconciliation begins. Snapshot it from the SAME Horizon moment as the opening balance — without a cursor anchor the indexer would walk the entire account history and double-count pre-baseline flow against the opening balance.',
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const OperatorFloatBaselineResult = registry.register(
    'OperatorFloatBaselineResult',
    z.object({
      id: z.string().uuid(),
      asset: z.enum(['xlm', 'usdc']),
      account: z.string(),
      openingBalanceStroops: z.string(),
      startingHorizonCursor: z.string().nullable(),
      active: z.number().int(),
      createdAt: z.string().datetime(),
    }),
  );

  const OperatorFloatBaselineEnvelope = registry.register(
    'OperatorFloatBaselineEnvelope',
    z.object({
      result: OperatorFloatBaselineResult,
      audit: OperatorFloatAdminWriteAudit,
    }),
  );

  const OperatorFloatManualMovementBody = registry.register(
    'OperatorFloatManualMovementBody',
    z.object({
      asset: z.enum(['xlm', 'usdc']),
      account: z.string().min(10).max(128),
      direction: z.enum(['in', 'out']),
      amountStroops: z
        .string()
        .regex(/^[0-9]+$/)
        .openapi({
          description:
            'Positive manual movement amount in stroops. Direction controls whether it adds to or subtracts from expected float.',
        }),
      movementPaymentId: z.string().min(1).max(200).optional().openapi({
        description:
          'Optional indexed Horizon payment id to classify as manual and bind to this explanation.',
      }),
      effectiveAt: z.string().datetime().optional(),
      reason: z.string().min(2).max(500),
    }),
  );

  const OperatorFloatManualMovementResult = registry.register(
    'OperatorFloatManualMovementResult',
    z.object({
      id: z.string().uuid(),
      asset: z.enum(['xlm', 'usdc']),
      account: z.string(),
      direction: z.enum(['in', 'out']),
      amountStroops: z.string(),
      movementPaymentId: z.string().nullable(),
      effectiveAt: z.string().datetime(),
      createdAt: z.string().datetime(),
    }),
  );

  const OperatorFloatManualMovementEnvelope = registry.register(
    'OperatorFloatManualMovementEnvelope',
    z.object({
      result: OperatorFloatManualMovementResult,
      audit: OperatorFloatAdminWriteAudit,
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
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operator-float/movements',
    summary: 'Operator wallet movement drilldown (R3-1).',
    description:
      'Lists indexed operator-wallet Horizon movements, defaulting to unclassified rows. Ops uses this after an operator-float alert to explain top-ups, sweeps, unexpected outbound payments, or orphan deposits before marking the float healthy.',
    request: {
      query: z.object({
        classification: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Operator wallet movements.',
        content: {
          'application/json': {
            schema: z.object({ movements: z.array(OperatorFloatMovement) }),
          },
        },
      },
      401: {
        description: 'Missing/invalid auth.',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Admin privileges required; masked as not found.',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limited.',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading indexed operator-wallet movements.',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/operator-float/baselines',
    summary: 'Set an audited operator-float reconciliation baseline (R3-1).',
    description:
      'Creates a new active baseline for an operator wallet and deactivates prior baselines for the same account + asset. ADR-017 admin-write discipline applies: admin actor from context, required Idempotency-Key, required reason, stored replay snapshot, Discord audit after commit, and ADR-028 step-up scope `operator-float`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description:
            'ADR-028 step-up JWT minted by `POST /api/admin/step-up` with scope `operator-float`.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: OperatorFloatBaselineBody } },
      },
    },
    responses: {
      200: {
        description: 'Baseline applied or replayed from idempotency snapshot.',
        content: { 'application/json': { schema: OperatorFloatBaselineEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid JSON, or invalid request body.',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token.',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Admin privileges required; masked as not found by the admin middleware.',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limited (10/min per IP).',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error applying the baseline, or corrupt idempotency replay snapshot.',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment.',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/operator-float/manual-movements',
    summary: 'Record an audited manual operator-float movement explanation (R3-1).',
    description:
      'Records a manual in/out movement that becomes part of expected operator float. When `movementPaymentId` is supplied, the indexed wallet movement is linked and classified as `manual`. ADR-017 admin-write discipline and ADR-028 step-up scope `operator-float` apply.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
        'x-admin-step-up': z.string().openapi({
          description:
            'ADR-028 step-up JWT minted by `POST /api/admin/step-up` with scope `operator-float`.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: OperatorFloatManualMovementBody } },
      },
    },
    responses: {
      200: {
        description: 'Manual movement applied or replayed from idempotency snapshot.',
        content: { 'application/json': { schema: OperatorFloatManualMovementEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid JSON, or invalid request body.',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token.',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Admin privileges required; masked as not found by the admin middleware.',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limited (20/min per IP).',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error applying the manual movement, or corrupt idempotency replay snapshot.',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment.',
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

  // Interest forward-mint forecast (ADR 009 / 015).
  registerAdminInterestMintForecastOpenApi(registry, errorResponse, LoopAssetCode);
}
