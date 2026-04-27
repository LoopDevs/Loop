/**
 * Admin section of the OpenAPI spec — schemas + path
 * registrations for `/api/admin/*` (the staff-only ops surface:
 * treasury snapshot, pending payouts, cashback-config CRUD,
 * per-merchant + per-user drill metrics, audit tail, CSV
 * exports, etc.).
 *
 * Sixth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders, #1156 users, #1157
 * public).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `loopAssetCode` — LOOP-asset code enum (USDLOOP / GBPLOOP /
 *   EURLOOP). Defined inline in openapi.ts because Users uses it
 *   too — passing in keeps the spec byte-identical without
 *   duplicating the schema.
 * - `payoutState` — pending_payouts lifecycle enum (pending /
 *   submitted / confirmed / failed). Same cross-section share as
 *   loopAssetCode.
 * - `cashbackPctString` — `numeric(5,2)`-as-string percentage
 *   schema. Shared with the Merchants section's bulk
 *   cashback-rate response.
 *
 * Every admin schema + path is preserved verbatim — every per-
 * route description, per-status response wiring, and per-section
 * divider is kept intact so the generated OpenAPI document stays
 * content-identical.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers all `/api/admin/*` schemas + paths on the supplied
 * registry. Called once from openapi.ts during module init.
 */
// Cross-section enum schemas the admin factory pulls from openapi.ts.
// `z.record` constrains its key to a Zod schema whose output is a
// string-like — the exact `z.ZodEnum<...>` type generic in zod 4 is
// hard to spell from outside the construction site, so we widen to
// the runtime shape (`{ enum: object }`) and let the call sites narrow
// via the local PascalCase aliases below.
type ZodEnumLike = z.ZodEnum<{ readonly [key: string]: string | number }>;

export function registerAdminOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: ZodEnumLike,
  payoutState: ZodEnumLike,
  cashbackPctString: z.ZodTypeAny,
): void {
  // Local aliases for the cross-section enums passed in by openapi.ts.
  // Kept as PascalCase consts so every schema reference inside the
  // admin body (which previously read the inline definitions) stays
  // syntactically identical to the pre-decomposition source.
  const LoopAssetCode = loopAssetCode;
  const PayoutState = payoutState;
  const CashbackPctString = cashbackPctString;

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

  const AdminPayoutView = registry.register(
    'AdminPayoutView',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      orderId: z.string().uuid().nullable().openapi({
        description:
          'Source order id for `kind=order_cashback` payouts. NULL for withdrawal-initiated payouts (ADR-024 §2).',
      }),
      kind: z.enum(['order_cashback', 'withdrawal']).openapi({
        description:
          'Discriminator: `order_cashback` is the legacy order-fulfilment payout; `withdrawal` is the ADR-024 admin-cash-out flow.',
      }),
      assetCode: z
        .string()
        .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
      assetIssuer: z.string().openapi({ description: 'Stellar issuer account for this asset.' }),
      toAddress: z.string().openapi({ description: 'Destination Stellar address (user wallet).' }),
      amountStroops: z
        .string()
        .openapi({ description: 'Payout amount in stroops. BigInt as string.' }),
      memoText: z.string().openapi({
        description: 'Memo that memo-idempotency pre-check searches for on retry (ADR 016).',
      }),
      state: PayoutState,
      txHash: z.string().nullable(),
      lastError: z.string().nullable().openapi({
        description: 'Most recent submit error (classified kind from payout-submit).',
      }),
      attempts: z.number().int(),
      createdAt: z.string(),
      submittedAt: z.string().nullable(),
      confirmedAt: z.string().nullable(),
      failedAt: z.string().nullable(),
    }),
  );

  const AdminPayoutListResponse = registry.register(
    'AdminPayoutListResponse',
    z.object({ payouts: z.array(AdminPayoutView) }),
  );

  // ─── Admin — top users (ADR 009 / 015) ─────────────────────────────────────

  const TopUserRow = registry.register(
    'TopUserRow',
    z.object({
      userId: z.string().uuid(),
      email: z.string().email(),
      currency: z.string().length(3),
      count: z.number().int().min(0),
      amountMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
    }),
  );

  const TopUsersResponse = registry.register(
    'TopUsersResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(TopUserRow),
    }),
  );

  // ─── Admin — audit tail (ADR 017 / 018) ────────────────────────────────────

  const AdminAuditTailRow = registry.register(
    'AdminAuditTailRow',
    z.object({
      actorUserId: z.string().uuid(),
      actorEmail: z.string().email(),
      method: z.string(),
      path: z.string(),
      status: z.number().int(),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminAuditTailResponse = registry.register(
    'AdminAuditTailResponse',
    z.object({ rows: z.array(AdminAuditTailRow) }),
  );

  // ─── Admin — payouts-by-asset breakdown (ADR 015 / 016) ────────────────────

  const PerStateBreakdown = registry.register(
    'PerStateBreakdown',
    z.object({
      count: z.number().int().min(0),
      stroops: z.string().openapi({ description: 'Sum of amount_stroops; bigint-as-string.' }),
    }),
  );

  const PayoutsByAssetRow = registry.register(
    'PayoutsByAssetRow',
    z.object({
      assetCode: z.string(),
      pending: PerStateBreakdown,
      submitted: PerStateBreakdown,
      confirmed: PerStateBreakdown,
      failed: PerStateBreakdown,
    }),
  );

  const PayoutsByAssetResponse = registry.register(
    'PayoutsByAssetResponse',
    z.object({ rows: z.array(PayoutsByAssetRow) }),
  );

  // ─── Admin — settlement-lag SLA (ADR 015 / 016) ────────────────────────────

  const SettlementLagRow = registry.register(
    'SettlementLagRow',
    z.object({
      assetCode: z.string().nullable().openapi({
        description: 'LOOP asset code; `null` for the fleet-wide aggregate row.',
      }),
      sampleCount: z.number().int().nonnegative(),
      p50Seconds: z.number().nonnegative(),
      p95Seconds: z.number().nonnegative(),
      maxSeconds: z.number().nonnegative(),
      meanSeconds: z.number().nonnegative(),
    }),
  );

  const SettlementLagResponse = registry.register(
    'SettlementLagResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(SettlementLagRow),
    }),
  );

  // ─── Admin — credit-adjustment write (ADR 017) ─────────────────────────────

  const AdminWriteAudit = registry.register(
    'AdminWriteAudit',
    z.object({
      actorUserId: z.string().uuid(),
      actorEmail: z.string().email(),
      idempotencyKey: z.string(),
      appliedAt: z.string().datetime(),
      replayed: z.boolean(),
    }),
  );

  const CreditAdjustmentBody = registry.register(
    'CreditAdjustmentBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Signed integer-as-string. Non-zero, within ±10_000_000 minor units. Positive = credit, negative = debit.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      reason: z.string().min(2).max(500),
    }),
  );

  const CreditAdjustmentResult = registry.register(
    'CreditAdjustmentResult',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const CreditAdjustmentEnvelope = registry.register(
    'CreditAdjustmentEnvelope',
    z.object({
      result: CreditAdjustmentResult,
      audit: AdminWriteAudit,
    }),
  );

  // A2-901 — admin refund write.
  const RefundBody = registry.register(
    'RefundBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Positive integer-as-string. 1..10_000_000 minor units. Refunds are credit-only; a debit should be a credit adjustment.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      orderId: z.string().uuid(),
      reason: z.string().min(2).max(500),
    }),
  );

  const RefundResult = registry.register(
    'RefundResult',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string(),
      orderId: z.string().uuid(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const RefundEnvelope = registry.register(
    'RefundEnvelope',
    z.object({
      result: RefundResult,
      audit: AdminWriteAudit,
    }),
  );

  // ─── Admin — withdrawal write (ADR-024 / A2-901) ──────────────────────────

  const WithdrawalBody = registry.register(
    'WithdrawalBody',
    z.object({
      amountMinor: z.string().openapi({
        description:
          'Positive integer-as-string. 1..10_000_000 minor units. Same cap as refund/adjustment.',
      }),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      destinationAddress: z.string().openapi({
        description: 'User Stellar wallet — `G` + 55 base32 chars.',
      }),
      reason: z.string().min(2).max(500),
    }),
  );

  const WithdrawalResult = registry.register(
    'WithdrawalResult',
    z.object({
      id: z
        .string()
        .uuid()
        .openapi({ description: 'credit_transactions.id of the new ledger row.' }),
      payoutId: z
        .string()
        .uuid()
        .openapi({ description: 'pending_payouts.id of the queued on-chain payout.' }),
      userId: z.string().uuid(),
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'Unsigned magnitude. The stored credit-tx row is negative.',
      }),
      destinationAddress: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const WithdrawalEnvelope = registry.register(
    'WithdrawalEnvelope',
    z.object({
      result: WithdrawalResult,
      audit: AdminWriteAudit,
    }),
  );

  // ─── Admin — per-merchant cashback stats (ADR 011 / 015) ───────────────────

  const MerchantStatsRow = registry.register(
    'MerchantStatsRow',
    z.object({
      merchantId: z.string(),
      currency: z.string().length(3),
      orderCount: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      lastFulfilledAt: z.string().datetime(),
    }),
  );

  const MerchantStatsResponse = registry.register(
    'MerchantStatsResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(MerchantStatsRow),
    }),
  );

  // ─── Admin — cashback-activity time-series (ADR 009 / 015) ─────────────────

  const AdminActivityPerCurrency = registry.register(
    'AdminActivityPerCurrency',
    z.object({
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
    }),
  );

  const CashbackActivityDay = registry.register(
    'CashbackActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      count: z.number().int().min(0),
      byCurrency: z.array(AdminActivityPerCurrency),
    }),
  );

  const CashbackActivityResponse = registry.register(
    'CashbackActivityResponse',
    z.object({
      days: z.number().int().min(1).max(180),
      rows: z.array(CashbackActivityDay),
    }),
  );

  // ─── Admin — cashback realization (ADR 009 / 015) ──────────────────────────

  const CashbackRealizationRow = registry.register(
    'CashbackRealizationRow',
    z.object({
      currency: z.string().length(3).nullable().openapi({
        description: 'ISO 4217 code; `null` for the fleet-wide aggregate row.',
      }),
      earnedMinor: z.string(),
      spentMinor: z.string(),
      withdrawnMinor: z.string(),
      outstandingMinor: z.string(),
      recycledBps: z.number().int().nonnegative().max(10_000).openapi({
        description: 'spent / earned, as basis points (10 000 = 100.00%).',
      }),
    }),
  );

  const CashbackRealizationResponse = registry.register(
    'CashbackRealizationResponse',
    z.object({ rows: z.array(CashbackRealizationRow) }),
  );

  const CashbackRealizationDay = registry.register(
    'CashbackRealizationDay',
    z.object({
      day: z.string().openapi({ description: 'ISO date (YYYY-MM-DD).' }),
      currency: z.string().length(3),
      earnedMinor: z.string(),
      spentMinor: z.string(),
      recycledBps: z.number().int().nonnegative().max(10_000),
    }),
  );

  const CashbackRealizationDailyResponse = registry.register(
    'CashbackRealizationDailyResponse',
    z.object({
      days: z.number().int().min(1).max(180),
      rows: z.array(CashbackRealizationDay),
    }),
  );

  // ─── Admin — stuck-orders triage ───────────────────────────────────────────

  const StuckOrderRow = registry.register(
    'StuckOrderRow',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      merchantId: z.string(),
      state: z.enum(['paid', 'procuring']),
      stuckSince: z.string().datetime(),
      ageMinutes: z.number().int().min(0),
      ctxOrderId: z.string().nullable(),
      ctxOperatorId: z.string().nullable(),
    }),
  );

  const StuckOrdersResponse = registry.register(
    'StuckOrdersResponse',
    z.object({
      thresholdMinutes: z.number().int().min(1),
      rows: z.array(StuckOrderRow),
    }),
  );

  // ─── Admin — stuck payouts (ADR 015 / 016) ─────────────────────────────────

  const StuckPayoutRow = registry.register(
    'StuckPayoutRow',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      orderId: z.string().uuid(),
      assetCode: z.string(),
      amountStroops: z.string(),
      state: z.string(),
      stuckSince: z.string().datetime(),
      ageMinutes: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
    }),
  );

  const StuckPayoutsResponse = registry.register(
    'StuckPayoutsResponse',
    z.object({
      thresholdMinutes: z.number().int().min(1),
      rows: z.array(StuckPayoutRow),
    }),
  );

  // ─── Admin — supplier spend (ADR 013 / 015) ────────────────────────────────

  const AdminSupplierSpendRow = registry.register(
    'AdminSupplierSpendRow',
    z.object({
      currency: z.string().length(3),
      count: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      marginBps: z.number().int().nonnegative().max(10_000).openapi({
        description: 'loopMargin / faceValue × 10 000. Clamped [0, 10 000].',
      }),
    }),
  );

  const AdminSupplierSpendResponse = registry.register(
    'AdminSupplierSpendResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminSupplierSpendRow),
    }),
  );

  // ─── Admin — supplier-spend activity (ADR 013 / 015) ───────────────────────

  const AdminSupplierSpendActivityDay = registry.register(
    'AdminSupplierSpendActivityDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      currency: z.string().length(3),
      count: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
    }),
  );

  const AdminSupplierSpendActivityResponse = registry.register(
    'AdminSupplierSpendActivityResponse',
    z.object({
      windowDays: z.number().int().min(1).max(180),
      currency: z.enum(['USD', 'GBP', 'EUR']).nullable(),
      days: z.array(AdminSupplierSpendActivityDay),
    }),
  );

  // ─── Admin — treasury credit-flow (ADR 009 / 015) ──────────────────────────

  const AdminTreasuryCreditFlowDay = registry.register(
    'AdminTreasuryCreditFlowDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      currency: z.string().length(3),
      creditedMinor: z.string(),
      debitedMinor: z.string(),
      netMinor: z.string(),
    }),
  );

  const AdminTreasuryCreditFlowResponse = registry.register(
    'AdminTreasuryCreditFlowResponse',
    z.object({
      windowDays: z.number().int().min(1).max(180),
      currency: z.enum(['USD', 'GBP', 'EUR']).nullable(),
      days: z.array(AdminTreasuryCreditFlowDay),
    }),
  );

  // ─── Admin — merchant × operator mix (ADR 013 / 022) ───────────────────────

  const AdminMerchantOperatorMixRow = registry.register(
    'AdminMerchantOperatorMixRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminMerchantOperatorMixResponse = registry.register(
    'AdminMerchantOperatorMixResponse',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminMerchantOperatorMixRow),
    }),
  );

  // ─── Admin — operator × merchant mix (ADR 013 / 022) ───────────────────────

  const AdminOperatorMerchantMixRow = registry.register(
    'AdminOperatorMerchantMixRow',
    z.object({
      merchantId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminOperatorMerchantMixResponse = registry.register(
    'AdminOperatorMerchantMixResponse',
    z.object({
      operatorId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminOperatorMerchantMixRow),
    }),
  );

  // ─── Admin — user × operator mix (ADR 013 / 022) ───────────────────────────

  const AdminUserOperatorMixRow = registry.register(
    'AdminUserOperatorMixRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminUserOperatorMixResponse = registry.register(
    'AdminUserOperatorMixResponse',
    z.object({
      userId: z.string().uuid(),
      since: z.string().datetime(),
      rows: z.array(AdminUserOperatorMixRow),
    }),
  );

  // ─── Admin — operator stats (ADR 013) ──────────────────────────────────────

  const AdminOperatorStatsRow = registry.register(
    'AdminOperatorStatsRow',
    z.object({
      operatorId: z.string(),
      orderCount: z.number().int().min(0),
      fulfilledCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      lastOrderAt: z.string().datetime(),
    }),
  );

  const AdminOperatorStatsResponse = registry.register(
    'AdminOperatorStatsResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminOperatorStatsRow),
    }),
  );

  // ─── Admin — operator latency (ADR 013 / 022) ──────────────────────────────

  const AdminOperatorLatencyRow = registry.register(
    'AdminOperatorLatencyRow',
    z.object({
      operatorId: z.string(),
      sampleCount: z.number().int().min(0),
      p50Ms: z.number().int().min(0),
      p95Ms: z.number().int().min(0),
      p99Ms: z.number().int().min(0),
      meanMs: z.number().int().min(0),
    }),
  );

  const AdminOperatorLatencyResponse = registry.register(
    'AdminOperatorLatencyResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(AdminOperatorLatencyRow),
    }),
  );

  // ─── Admin — per-operator supplier spend (ADR 013 / 015 / 022) ─────────────

  const AdminOperatorSupplierSpendResponse = registry.register(
    'AdminOperatorSupplierSpendResponse',
    z.object({
      operatorId: z.string(),
      since: z.string().datetime(),
      rows: z.array(AdminSupplierSpendRow),
    }),
  );

  // ─── Admin — per-operator activity (ADR 013 / 022) ─────────────────────────

  const AdminOperatorActivityDay = registry.register(
    'AdminOperatorActivityDay',
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      created: z.number().int().min(0),
      fulfilled: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  );

  const AdminOperatorActivityResponse = registry.register(
    'AdminOperatorActivityResponse',
    z.object({
      operatorId: z.string(),
      windowDays: z.number().int().min(1).max(90),
      days: z.array(AdminOperatorActivityDay),
    }),
  );

  // ─── Admin — user detail ────────────────────────────────────────────────────

  const AdminUserView = registry.register(
    'AdminUserView',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.string().length(3),
      stellarAddress: z.string().nullable(),
      ctxUserId: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  // ─── Admin — user directory ─────────────────────────────────────────────────

  const AdminUserListRow = registry.register(
    'AdminUserListRow',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.string().length(3),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminUserListResponse = registry.register(
    'AdminUserListResponse',
    z.object({ users: z.array(AdminUserListRow) }),
  );

  // ─── Admin — per-user credit balance (ADR 009) ──────────────────────────────

  const AdminUserCreditRow = registry.register(
    'AdminUserCreditRow',
    z.object({
      currency: z.string().length(3),
      balanceMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units of the currency (cents, pence).',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const AdminUserCreditsResponse = registry.register(
    'AdminUserCreditsResponse',
    z.object({
      userId: z.string().uuid(),
      rows: z.array(AdminUserCreditRow),
    }),
  );

  // ─── Admin — per-user credit transactions (ADR 009) ─────────────────────────

  const CreditTransactionType = z
    .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
    .openapi({ description: 'Mirrors the CHECK constraint on credit_transactions.type.' });

  const AdminCreditTransactionView = registry.register(
    'AdminCreditTransactionView',
    z.object({
      id: z.string().uuid(),
      type: CreditTransactionType,
      amountMinor: z.string().openapi({
        description:
          'bigint-as-string, signed. Positive for cashback/interest/refund, negative for spend/withdrawal; adjustment can be either.',
      }),
      currency: z.string().length(3),
      referenceType: z.string().nullable(),
      referenceId: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminCreditTransactionListResponse = registry.register(
    'AdminCreditTransactionListResponse',
    z.object({ transactions: z.array(AdminCreditTransactionView) }),
  );

  // ─── Admin — Loop-native order view (ADR 011 / 015) ─────────────────────────

  const AdminOrderState = z
    .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
    .openapi({ description: 'Mirrors the CHECK constraint on orders.state.' });

  const AdminOrderPaymentMethod = z.enum(['xlm', 'usdc', 'credit', 'loop_asset']);

  const AdminOrderView = registry.register(
    'AdminOrderView',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      merchantId: z.string(),
      state: AdminOrderState,
      currency: z.string().length(3),
      faceValueMinor: z.string(),
      chargeCurrency: z.string().length(3),
      chargeMinor: z.string(),
      paymentMethod: AdminOrderPaymentMethod,
      wholesalePct: z.string(),
      userCashbackPct: z.string(),
      loopMarginPct: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      ctxOrderId: z.string().nullable(),
      ctxOperatorId: z.string().nullable(),
      failureReason: z.string().nullable(),
      createdAt: z.string().datetime(),
      paidAt: z.string().datetime().nullable(),
      procuredAt: z.string().datetime().nullable(),
      fulfilledAt: z.string().datetime().nullable(),
      failedAt: z.string().datetime().nullable(),
    }),
  );
  // ─── Admin — cashback-config (ADR 011) ──────────────────────────────────────
  //
  // Percentages are stored as `numeric(5,2)` and round-trip as strings
  // through postgres-js (`"80.00"`). The schema mirrors that wire shape
  // so clients don't silently coerce to JS numbers and drift.

  const AdminCashbackConfig = registry.register(
    'AdminCashbackConfig',
    z.object({
      merchantId: z.string(),
      wholesalePct: CashbackPctString,
      userCashbackPct: CashbackPctString,
      loopMarginPct: CashbackPctString,
      active: z.boolean(),
      updatedBy: z.string().openapi({
        description: 'Admin user id that performed the most recent upsert.',
      }),
      updatedAt: z.string().datetime(),
    }),
  );

  const AdminCashbackConfigListResponse = registry.register(
    'AdminCashbackConfigListResponse',
    z.object({ configs: z.array(AdminCashbackConfig) }),
  );

  // A2-502: ADR-017 envelope returned by the upsert endpoint. Mirrors
  // CreditAdjustmentEnvelope / RefundEnvelope — `result` is the updated
  // config row, `audit` is the shared admin-write audit shape that every
  // ADR-017 mutation returns.
  const AdminCashbackConfigEnvelope = registry.register(
    'AdminCashbackConfigEnvelope',
    z.object({
      result: AdminCashbackConfig,
      audit: AdminWriteAudit,
    }),
  );

  const UpsertCashbackConfigBody = registry.register(
    'UpsertCashbackConfigBody',
    z
      .object({
        wholesalePct: z.coerce.number().min(0).max(100),
        userCashbackPct: z.coerce.number().min(0).max(100),
        loopMarginPct: z.coerce.number().min(0).max(100),
        active: z.boolean().optional(),
        reason: z.string().min(2).max(500).openapi({
          description:
            'A2-502 / ADR 017: operator-authored rationale for the edit. Fanned out to the admin-audit Discord channel and (A2-908) persisted on any downstream ledger writes — NOT on the config row itself, which carries its own audit trail via the `merchant_cashback_config_history` trigger.',
        }),
      })
      .openapi({
        description:
          'The three split percentages are coerced from number-or-numeric-string and must sum to ≤100. `active` defaults to true on initial insert. `reason` is required per ADR 017 admin-write contract.',
      }),
  );

  const AdminCashbackConfigHistoryRow = registry.register(
    'AdminCashbackConfigHistoryRow',
    z.object({
      id: z.string().uuid(),
      merchantId: z.string(),
      wholesalePct: CashbackPctString,
      userCashbackPct: CashbackPctString,
      loopMarginPct: CashbackPctString,
      active: z.boolean(),
      changedBy: z.string().openapi({
        description: 'Admin user id that triggered the prior-row snapshot.',
      }),
      changedAt: z.string().datetime(),
    }),
  );

  const AdminCashbackConfigHistoryResponse = registry.register(
    'AdminCashbackConfigHistoryResponse',
    z.object({ history: z.array(AdminCashbackConfigHistoryRow) }),
  );

  // ─── Admin — treasury + payouts (ADR 015) ───────────────────────────────────

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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/discord/config',
    summary: 'Discord webhook configuration status (ADR 018).',
    description:
      "Read-only companion to `POST /api/admin/discord/test`. Reports whether each webhook env var is set so the admin panel can render a 'configured' / 'missing' badge next to each channel without POSTing. Never echoes the actual webhook URL — those are secrets.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Config status',
        content: {
          'application/json': {
            schema: z.object({
              orders: z.enum(['configured', 'missing']),
              monitoring: z.enum(['configured', 'missing']),
              adminAudit: z.enum(['configured', 'missing']),
            }),
          },
        },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts',
    summary: 'Paginated pending-payouts backlog (ADR 015).',
    description:
      'Admin drills into the payouts page from the treasury snapshot state counts. Filter with `?state=failed` (or pending / submitted / confirmed), page older rows with `?before=<iso-8601>`, cap with `?limit=` (default 20, max 100).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: PayoutState.optional().openapi({
          description: 'Filter to a single lifecycle state. Omitted → all states.',
        }),
        userId: z.string().uuid().optional().openapi({
          description:
            'Filter to a single user. Powers the user-detail payouts section — without this ops would have to grep through the full list for a user.',
        }),
        before: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — return rows strictly older than this createdAt.' }),
        limit: z.coerce.number().int().min(1).max(100).optional().openapi({
          description: 'Page size. Default 20, hard-capped at 100.',
        }),
        kind: z.enum(['order_cashback', 'withdrawal']).optional().openapi({
          description:
            'ADR-024 §2 discriminator filter. `order_cashback` = legacy order-fulfilment payout; `withdrawal` = admin cash-out from balance. Omitted → both.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Payout rows',
        content: { 'application/json': { schema: AdminPayoutListResponse } },
      },
      400: {
        description: 'Invalid state or before',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts/{id}',
    summary: 'Single pending-payout drill-down (ADR 015).',
    description:
      'Permalink view for one pending_payouts row, used by the admin UI to deep-link a stuck / failed payout into a ticket or incident note without scrolling the list. 404 when the id matches nothing.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: AdminPayoutView } },
      },
      400: {
        description: 'Missing or malformed id',
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
      404: {
        description: 'Payout not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/top-users',
    summary: 'Top users by cashback earned (ADR 009 / 015).',
    description:
      "Ranked list of users with the highest `cashback`-type credit_transactions in the window. Groups by `(user, currency)` — fleet-wide totals across currencies aren't meaningful. Two shoulders use this: ops recognition ('top earners this month') and concentration-risk signal ('one user accounts for 70% — why?'). Default window 30 days, capped at 366. `?limit=` clamped 1..100, default 20.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked rows, highest amountMinor first',
        content: { 'application/json': { schema: TopUsersResponse } },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the ranking',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/audit-tail',
    summary: 'Newest-first admin write-audit tail (ADR 017 / 018).',
    description:
      "Returns the most recent rows from `admin_idempotency_keys` — the persistent mirror of every admin write. Admin dashboard surfaces this as a 'Recent admin activity' card so ops can review without scrolling the Discord channel. Response body is deliberately stripped (method / path / status / timestamp / actor only) — the audit story is 'who did what, when' not 'here's the stored snapshot'. `?limit=` clamps 1..100, default 25. `?before=<iso>` paginates older rows by `createdAt`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Audit rows, newest first',
        content: { 'application/json': { schema: AdminAuditTailResponse } },
      },
      400: {
        description: '`before` is not a valid ISO-8601 timestamp',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the audit tail',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-by-asset',
    summary: 'Per-asset × per-state payout breakdown (ADR 015 / 016).',
    description:
      "Crosses `pending_payouts` by `(asset_code, state)`. The treasury snapshot gives per-state counts and per-asset outstanding liability separately; this endpoint answers the crossed question ops asks during an incident — 'I see N failed payouts, which LOOP assets are affected?'. All amounts in stroops, bigint-as-string.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per asset_code present in pending_payouts',
        content: { 'application/json': { schema: PayoutsByAssetResponse } },
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
      500: {
        description: 'Internal error computing the breakdown',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts/settlement-lag',
    summary: 'Payout settlement-lag SLA (ADR 015 / 016).',
    description:
      "Percentile latency (in seconds) from `pending_payouts` insert (`createdAt`) to on-chain confirmation (`confirmedAt`) for `state='confirmed'` rows in the window. One row per LOOP asset, plus a fleet-wide aggregate where `assetCode: null`. The user-facing SLA: if p95 is minutes we're healthy; hours means the payout worker or Horizon is backed up and users are waiting. Window: `?since=<iso>` (default 24h, cap 366d). Same clamp as the operator-latency endpoint.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description: 'ISO-8601 — lower bound on `confirmedAt`. Defaults to 24h ago.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Per-asset rows plus fleet-wide aggregate',
        content: { 'application/json': { schema: SettlementLagResponse } },
      },
      400: {
        description: 'Malformed `since` or window > 366d',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PayoutRetryBody = registry.register(
    'PayoutRetryBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutRetryEnvelope = registry.register(
    'PayoutRetryEnvelope',
    z.object({
      result: AdminPayoutView,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/retry',
    summary: 'Flip a failed payout back to pending (ADR 015 / 016 / 017).',
    description:
      'Admin-only manual retry: resets a `failed` pending_payouts row to `pending` so the submit worker picks it up on the next tick. 404 when the id matches nothing or the row is in a non-failed state. ADR 017 compliant: `Idempotency-Key` header + `reason` body required; a repeat call returns the stored snapshot with `audit.replayed: true`. Worker enforces memo-idempotency on re-submit (ADR 016) so double-retry never double-pays.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutRetryBody } },
      },
    },
    responses: {
      200: {
        description: 'Retry applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutRetryEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or malformed id',
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
      404: {
        description: 'Payout not found or not in failed state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resetting the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PayoutCompensationBody = registry.register(
    'PayoutCompensationBody',
    z.object({
      reason: z.string().min(2).max(500),
    }),
  );

  const PayoutCompensationResult = registry.register(
    'PayoutCompensationResult',
    z.object({
      id: z.string().uuid(),
      payoutId: z.string().uuid(),
      userId: z.string().uuid(),
      currency: z.enum(['USD', 'GBP', 'EUR']),
      amountMinor: z.string(),
      priorBalanceMinor: z.string(),
      newBalanceMinor: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const PayoutCompensationEnvelope = registry.register(
    'PayoutCompensationEnvelope',
    z.object({
      result: PayoutCompensationResult,
      audit: AdminWriteAudit,
    }),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/admin/payouts/{id}/compensate',
    summary: 'Compensate a permanently-failed withdrawal payout (ADR-024 §5).',
    description:
      'Re-credits the user after their withdrawal payout permanently failed on-chain. Writes a positive `type=adjustment` row referencing the payout id; net result is the original withdrawal debit is offset and the user is back to where they started. Manual-only (Phase 2a) — finance reviews failures before triggering. 400 if the payout is not a withdrawal; 409 if the payout is in any state other than `failed`. ADR 017 compliant: `Idempotency-Key` header + `reason` body required.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: PayoutCompensationBody } },
      },
    },
    responses: {
      200: {
        description: 'Compensation applied (or replayed from snapshot)',
        content: { 'application/json': { schema: PayoutCompensationEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid reason, malformed id, or payout is not a withdrawal',
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
      404: {
        description: 'Payout not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: "Payout is not in 'failed' state — only failed payouts can be compensated",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying compensation',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/activity',
    summary: 'Per-day orders created/fulfilled sparkline (ADR 010 / 019 Tier 1).',
    description:
      "Last `?days=<N>` (default 7, clamped [1, 90]) of orders created vs fulfilled, UTC-bucketed. Uses `generate_series` + LEFT JOIN so every day in the window appears with zero-filled counts even when no orders crossed on that day — the UI doesn't gap-fill. Oldest-first so a bar chart renders left-to-right without a client-side reverse.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).optional().openapi({
          description: 'Window size in calendar days. Default 7, clamped [1, 90].',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Activity series',
        content: {
          'application/json': {
            schema: z.object({
              windowDays: z.number().int().min(1).max(90),
              days: z.array(
                z.object({
                  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  created: z.number().int().nonnegative(),
                  fulfilled: z.number().int().nonnegative(),
                }),
              ),
            }),
          },
        },
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
      500: {
        description: 'Internal error reading activity',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/payment-method-share',
    summary: 'Payment-method share across orders (ADR 010 / 015).',
    description:
      "The cashback-flywheel metric. Single GROUP BY over `orders.payment_method`, zero-filled across every `ORDER_PAYMENT_METHODS` value so a method with no rows still renders as `{ orderCount: 0, chargeMinor: '0' }`. Default `?state=fulfilled` so in-flight orders don't skew the mix while users are still on the checkout page; pass any other `OrderState` to track a different bucket. `totalOrders` is echoed so the UI can render shares without re-summing. A rising `loop_asset` share is the signal ADR 015's cashback-recycle flywheel is working.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Payment-method share snapshot',
        content: {
          'application/json': {
            schema: z.object({
              state: z.enum([
                'pending_payment',
                'paid',
                'procuring',
                'fulfilled',
                'failed',
                'expired',
              ]),
              totalOrders: z.number().int().min(0),
              byMethod: z.record(
                z.enum(['xlm', 'usdc', 'credit', 'loop_asset']),
                z.object({
                  orderCount: z.number().int().min(0),
                  chargeMinor: z.string(),
                }),
              ),
            }),
          },
        },
      },
      400: {
        description: 'Invalid state',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the share',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/{orderId}',
    summary: 'Single Loop-native order drill-down (ADR 011 / 015).',
    description:
      'Permalink view for one `orders` row. Admin UI deep-links each row from the list page to this endpoint so ops can quote an order id in a ticket or incident note. Gift-card fields (redeem_code / redeem_pin) are omitted — the admin view is for diagnosis, not redemption.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Order row',
        content: { 'application/json': { schema: AdminOrderView } },
      },
      400: {
        description: 'Missing or malformed orderId',
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
      404: {
        description: 'Order not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/{orderId}/payout',
    summary: 'Payout row for a given order (ADR 015).',
    description:
      'Nested lookup — given an order id, return the single `pending_payouts` row associated with it (UNIQUE on `order_id`). Used by the admin order drill-down to render payout state without a second round-trip. 404 when the order has no payout row yet (common: payout builder only runs once cashback is due).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: AdminPayoutView } },
      },
      400: {
        description: 'Missing or malformed orderId',
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
      404: {
        description: 'No payout row for this order',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/supplier-spend',
    summary: 'Per-currency supplier-spend snapshot (ADR 013 / 015).',
    description:
      'Aggregates fulfilled orders in the window by catalog currency. Each row exposes count, total face value, wholesale cost billed by CTX, user cashback, and loop margin retained — all `bigint`-minor as strings. Default window is the last 24h; pass `?since=<iso-8601>` to walk back. Capped at 366 days to keep the postgres aggregate cheap.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on fulfilledAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-currency supplier-spend rows',
        content: { 'application/json': { schema: AdminSupplierSpendResponse } },
      },
      400: {
        description: 'Invalid `since`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operator-stats',
    summary: 'Per-operator order volume + success rate (ADR 013).',
    description:
      "Groups orders in the window by `ctx_operator_id`, skipping pre-procurement rows where the operator is still null. Each row carries the total order count, fulfilled count, failed count, and the most-recent createdAt attributed to that operator. Ordered by order_count descending so the top-traffic account surfaces first. Complements `/api/admin/supplier-spend` — that one answers 'what did we pay CTX', this one answers 'which operator actually did the work'. Default window 24h, capped at 366 days.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-operator stats rows',
        content: { 'application/json': { schema: AdminOperatorStatsResponse } },
      },
      400: {
        description: 'Invalid `since`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/latency',
    summary: 'Per-operator fulfilment latency — p50/p95/p99 ms (ADR 013 / 022).',
    description:
      'Percentile fulfilment latency (`fulfilledAt - paidAt`, ms) per `ctx_operator_id` for fulfilled orders in the window. Complements `/api/admin/operator-stats` — stats says which operator is busy; this says which is slow. A busy operator with a rising p95 is the early signal before the circuit breaker trips. Only rows with both timestamps set + non-null operator are aggregated — mid-flight orders would poison the percentiles. Sorted by p95 descending so the slowest operator surfaces first. Default window 24h, capped 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on fulfilledAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-operator latency rows',
        content: { 'application/json': { schema: AdminOperatorLatencyResponse } },
      },
      400: {
        description: 'Invalid or out-of-window `since`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/supplier-spend',
    summary: 'Per-operator supplier-spend by currency (ADR 013 / 015 / 022).',
    description:
      "Per-currency aggregate of what Loop paid CTX for fulfilled orders carried by one specific operator. ADR-022 per-operator axis of the fleet `/api/admin/supplier-spend` — that says 'total across operators', this says 'how much did op-X drive'. Same per-currency row shape (bigint-as-string money). Zero-volume operators return 200 with `rows: []`. Default window 24h, capped 366d.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        operatorId: z.string().min(1).max(128),
      }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on fulfilledAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-currency supplier-spend rows for the operator',
        content: { 'application/json': { schema: AdminOperatorSupplierSpendResponse } },
      },
      400: {
        description: 'Malformed `operatorId` or `since`',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/activity',
    summary: 'Per-operator daily activity time-series (ADR 013 / 022).',
    description:
      'Per-day created / fulfilled / failed order counts for one operator over the last N calendar days (default 7, cap 90, UTC-bucketed). Zero-filled by the backend (`LEFT JOIN generate_series`) so the layout is stable even when the operator is idle. A rising `failed` line or a dropping `fulfilled / created` ratio is a scheduler-tuning / CTX-escalation signal before the circuit breaker trips.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        operatorId: z.string().min(1).max(128),
      }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day activity series',
        content: { 'application/json': { schema: AdminOperatorActivityResponse } },
      },
      400: {
        description: 'Malformed `operatorId`',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error loading activity',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/supplier-spend/activity',
    summary: 'Per-day per-currency supplier-spend time-series (ADR 013 / 015).',
    description:
      "Time-axis of `/api/admin/supplier-spend`: per-day aggregate of face/wholesale/cashback/margin for fulfilled orders bucketed by `fulfilled_at::date` (UTC). `?currency=USD|GBP|EUR` zero-fills days via LEFT JOIN; without the filter, only (day, currency) pairs with activity appear. Pairs with `/api/admin/treasury/credit-flow` (ledger in) and `/api/admin/payouts-activity` (chain settle out) as the 'treasury-velocity triplet' ops watches to know money moved as expected today.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day per-currency rows',
        content: { 'application/json': { schema: AdminSupplierSpendActivityResponse } },
      },
      400: {
        description: 'Unknown `currency`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury/credit-flow',
    summary: 'Per-day credited/debited/net ledger flow (ADR 009 / 015).',
    description:
      "Per-day × per-currency ledger delta from `credit_transactions`. Answers the treasury question the snapshot can't: 'are we generating liability faster than we settle it?'. A week of net > 0 days means cashback issuance is outpacing user settlement — treasury plans Stellar-side funding ahead of the curve. Credited = sum(amount_minor) for positive-amount types (cashback, interest, refund) + positive adjustments; debited = abs(sum) for negative-amount types (spend, withdrawal). bigint-as-string. `?currency` zero-fills; default 30d, cap 180d.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day credit-flow rows',
        content: { 'application/json': { schema: AdminTreasuryCreditFlowResponse } },
      },
      400: {
        description: 'Unknown `currency`',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/asset-drift/state',
    summary: 'In-memory snapshot of the asset-drift watcher (ADR 015).',
    description:
      "Surfaces the background drift watcher's last-pass per-asset state without forcing a fresh Horizon read. `running: false` means the watcher is not active in this process (no LOOP issuers configured or `LOOP_WORKERS_ENABLED=false`). `perAsset[].state` is `unknown` until the first successful per-asset tick. Cheap enough to poll from the admin landing (120/min rate limit).",
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
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/operator-mix',
    summary: 'Per-merchant × per-operator attribution (ADR 013 / 022).',
    description:
      "For one merchant, aggregate orders by `ctx_operator_id`. Exposes the merchant × operator axis currently not surfaced by `/operator-stats` (fleet, any merchant) or `/merchant-stats` (fleet, any operator). Answers the incident-triage question: 'merchant X is slow right now — which operator is primarily carrying them?'. Zero-attribution merchants return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        merchantId: z.string().min(1).max(128),
      }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-operator rows scoped to the merchant',
        content: { 'application/json': { schema: AdminMerchantOperatorMixResponse } },
      },
      400: {
        description: 'Malformed `merchantId` or `since`',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators/{operatorId}/merchant-mix',
    summary: 'Per-operator × per-merchant attribution (ADR 013 / 022).',
    description:
      'Dual of `/api/admin/merchants/{merchantId}/operator-mix` — aggregates orders by `merchant_id` for one operator. Closes the operator × merchant matrix in both directions: incident-triage lands on the /merchants side ("which operator is carrying this problematic merchant?"); capacity-reviews land here ("which merchants is this operator carrying — concentration-risk or SLA lever?"). Zero-mix operators return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated. Default window 24h, capped 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        operatorId: z.string().min(1).max(128),
      }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rows scoped to the operator',
        content: { 'application/json': { schema: AdminOperatorMerchantMixResponse } },
      },
      400: {
        description: 'Malformed `operatorId` or `since`',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users',
    summary: 'Paginated user directory.',
    description:
      'Newest-first paginated list of Loop users. Optional `?q=` filters emails with a case-insensitive `ILIKE` fragment match (LIKE metacharacters escaped). Cursor pagination via `?before=<iso-8601>` on `createdAt`. Cap via `?limit=` (default 20, max 100). Complements the exact-by-id drill at `/api/admin/users/:userId`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z.string().max(254).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'User rows (newest first)',
        content: { 'application/json': { schema: AdminUserListResponse } },
      },
      400: {
        description: 'Invalid q / before / limit',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/by-email',
    summary: 'Exact-match user lookup by email.',
    description:
      "Support pastes the full email address from a customer ticket and gets the user row back in one request. Exact equality against a lowercase-normalised form — `Alice@Example.COM` matches `alice@example.com`. Distinct from `/api/admin/users?q=` which is the ILIKE-fragment browse surface; this one is the 'I have the address, give me the user' lookup. 404 on miss (no row exists for that normalised email).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        email: z.string().min(1).max(254),
      }),
    },
    responses: {
      200: {
        description: 'User row',
        content: { 'application/json': { schema: AdminUserView } },
      },
      400: {
        description: 'Missing, malformed, or overlong email',
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
      404: {
        description: 'No user with that email',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/top-by-pending-payout',
    summary: 'Top users by outstanding on-chain payout obligation.',
    description:
      "Ranked by current unfilled payout debt. Grouped by `(user, asset)` so funding decisions stay per-asset — a user owed both USDLOOP and GBPLOOP appears twice, once per asset. Includes only rows in `state IN ('pending', 'submitted')`; `failed` rows aren't counted (triage them at `/admin/payouts?state=failed` — retrying them transitions them back to `pending` and rejoins this leaderboard). Complements `/api/admin/top-users` (lifetime earnings); this one ranks by *current debt*. `?limit=` clamped 1..100, default 20.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked (user, asset) entries',
        content: {
          'application/json': {
            schema: z.object({
              entries: z.array(
                z.object({
                  userId: z.string().uuid(),
                  email: z.string().email(),
                  assetCode: z.string(),
                  totalStroops: z.string(),
                  payoutCount: z.number().int().min(0),
                }),
              ),
            }),
          },
        },
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
      500: {
        description: 'Internal error computing the leaderboard',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}',
    summary: 'Single-user detail for the admin panel.',
    description:
      "Entry point for the admin panel's user-detail page. Returns the full user row — email, home currency, admin flag, Stellar address, CTX linkage, created/updated timestamps. Subsequent per-user drills (credits, credit-transactions, orders) key off the id this endpoint returns.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'User row',
        content: { 'application/json': { schema: AdminUserView } },
      },
      400: {
        description: 'Missing or malformed userId',
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
      404: {
        description: 'User not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/credits',
    summary: 'Per-user credit balance drill-down (ADR 009).',
    description:
      'Returns every `user_credits` row for the given user. Ops opens this from a support ticket — complements the fleet-wide treasury aggregate by answering "what does Loop owe *this* user?". Empty `rows` is a valid response (user has never earned cashback or has fully redeemed).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Per-currency balances for the user',
        content: { 'application/json': { schema: AdminUserCreditsResponse } },
      },
      400: {
        description: 'Missing or malformed userId',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the ledger',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/credit-transactions',
    summary: 'Per-user credit-transaction log (ADR 009).',
    description:
      'Newest-first paginated list of `credit_transactions` rows for the user. The balance drill-down at `/api/admin/users/:userId/credits` answers "what is owed"; this endpoint answers "how did the balance get there?". Cursor pagination via `?before=<iso-8601>`; cap with `?limit=` (default 20, max 100); filter to a single kind with `?type=`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        type: CreditTransactionType.optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Credit-transaction rows (newest first)',
        content: { 'application/json': { schema: AdminCreditTransactionListResponse } },
      },
      400: {
        description: 'Invalid userId / type / before / limit',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the ledger',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/operator-mix',
    summary: 'Per-user × per-operator attribution for support triage (ADR 013 / 022).',
    description:
      'Third corner of the mix-axis triangle (alongside /merchants/{id}/operator-mix and /operators/{id}/merchant-mix). Aggregates orders for one user by ctx_operator_id. Support pivots here during per-user complaints: "user X\'s slow cashback → 80% of their orders went through op-beta-02 which has a failing circuit". Zero-mix users return 200 with rows: []. Only rows with non-null `ctx_operator_id` aggregated. Default window 24h, cap 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        since: z
          .string()
          .datetime()
          .optional()
          .openapi({ description: 'ISO-8601 — lower bound on createdAt. Defaults to 24h ago.' }),
      }),
    },
    responses: {
      200: {
        description: 'Per-operator rows scoped to the user',
        content: { 'application/json': { schema: AdminUserOperatorMixResponse } },
      },
      400: {
        description: 'Malformed `userId` or `since`',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/credit-adjustments',
    summary: 'Apply a signed admin credit adjustment (ADR 017).',
    description:
      "Writes a signed `credit_transactions` row (`type='adjustment'`) and atomically bumps `user_credits.balance_minor`. All five ADR-017 invariants enforced: actor from `requireAdmin`, `Idempotency-Key` header required, `reason` body field (2..500 chars), append-only ledger, Discord audit fanout AFTER commit. Response envelope is uniform across admin writes: `{ result, audit }`, where `audit.replayed: true` indicates a snapshot replay.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: CreditAdjustmentBody } },
      },
    },
    responses: {
      200: {
        description: 'Adjustment applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: CreditAdjustmentEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId',
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
        description: 'Debit would drive the balance below zero (INSUFFICIENT_BALANCE)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the adjustment',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // A2-901 — admin refund write. Same ADR-017 discipline as credit-
  // adjustments (actor from requireAdmin, Idempotency-Key header,
  // reason body field, append-only ledger, Discord audit) + DB-level
  // duplicate-refund rejection via the partial unique index on
  // (type, reference_type, reference_id) landed in migration 0013.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/refunds',
    summary: 'Issue a refund credit bound to an order (A2-901 + ADR 017).',
    description:
      "Writes a positive-amount `credit_transactions` row (`type='refund'`, `reference_type='order'`, `reference_id=<orderId>`) and atomically bumps `user_credits.balance_minor`. Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB partial unique index on (type, reference_type, reference_id) rejects a second refund row for the same order with 409 `REFUND_ALREADY_ISSUED`.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: RefundBody } },
      },
    },
    responses: {
      200: {
        description: 'Refund applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: RefundEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid body, or non-uuid userId / orderId',
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
        description: 'A refund has already been issued for this order (REFUND_ALREADY_ISSUED)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the refund',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // A2-901 / ADR-024 — admin withdrawal write. Same ADR-017
  // discipline as refund (Idempotency-Key, audit envelope, Discord
  // notify). Atomic two-row write debits user_credits + queues a
  // LOOP-asset pending_payouts row. The partial unique index on
  // (type, reference_type, reference_id) extended in migration 0022
  // rejects a duplicate withdrawal credit-tx for the same payout id
  // with 409 WITHDRAWAL_ALREADY_ISSUED.
  registry.registerPath({
    method: 'post',
    path: '/api/admin/users/{userId}/withdrawals',
    summary:
      'Issue a withdrawal — debit cashback balance + queue on-chain payout (A2-901 / ADR-024).',
    description:
      "Writes a negative-amount `credit_transactions` row (`type='withdrawal'`, `reference_type='payout'`, `reference_id=<pending_payouts.id>`), atomically decrements `user_credits.balance_minor`, and queues a LOOP-asset payout row for the on-chain submit worker. Idempotent in two layers: the admin idempotency key replays the stored snapshot on repeat (ADR 017), and the DB partial unique index on (type, reference_type, reference_id) — extended to include 'withdrawal' in migration 0022 — rejects a second credit-tx for the same payout id with 409 `WITHDRAWAL_ALREADY_ISSUED`. Phase 2a is admin-mediated only; user-initiated cash-out is deferred to Phase 2b.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
        }),
      }),
      body: {
        content: { 'application/json': { schema: WithdrawalBody } },
      },
    },
    responses: {
      200: {
        description: 'Withdrawal applied (or replayed from idempotency snapshot)',
        content: { 'application/json': { schema: WithdrawalEnvelope } },
      },
      400: {
        description:
          'Missing idempotency key, invalid body, non-uuid userId, or insufficient balance (`INSUFFICIENT_BALANCE`)',
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
      404: {
        description: 'Target user not found (`NOT_FOUND`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description:
          'A withdrawal credit-tx already references this payout id (`WITHDRAWAL_ALREADY_ISSUED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error applying the withdrawal',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description:
          'LOOP issuer for the requested currency not configured in env (`NOT_CONFIGURED`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/merchants/resync',
    summary: 'Force an immediate merchant-catalog sweep of the upstream CTX API.',
    description:
      'Ops override for the 6-hour scheduled `refreshMerchants` timer (ADR 011). Runs the same paginated sweep on-demand and atomically replaces the in-memory merchant cache once the new snapshot is fully built. Two admins clicking simultaneously coalesce into one upstream sweep via the existing refresh mutex: one response sees `triggered: true`, the other `triggered: false` with the same post-sync `loadedAt`. 502 on upstream failure, not 500 — the cached snapshot is retained so `/api/merchants` keeps serving prior data. Tight 2/min rate limit because every hit goes to CTX.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Post-sync snapshot summary',
        content: {
          'application/json': {
            schema: z.object({
              merchantCount: z.number().int().min(0),
              loadedAt: z.string().datetime(),
              triggered: z.boolean(),
            }),
          },
        },
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
        description: 'Rate limit exceeded (2/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream CTX catalog fetch failed — cached snapshot retained',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/discord/notifiers',
    summary: 'Static catalog of Discord notifiers (ADR 018).',
    description:
      'Zero-DB read of the `DISCORD_NOTIFIERS` const in `apps/backend/src/discord.ts`. Powers the admin UI surface that renders "what signals can this system send us?" without rebuilding the list from ADR prose. No secrets — `channel` is the symbolic name (`orders`, `monitoring`, `admin-audit`), not the webhook URL. A new notifier lands with its catalog entry in the same PR, so this response is always in lockstep with the code.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Frozen catalog of notifiers',
        content: {
          'application/json': {
            schema: z.object({
              notifiers: z.array(
                z.object({
                  name: z.string(),
                  channel: z.enum(['orders', 'monitoring', 'admin-audit']),
                  description: z.string(),
                }),
              ),
            }),
          },
        },
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

  registry.registerPath({
    method: 'post',
    path: '/api/admin/discord/test',
    summary: 'Fire a benign test ping at a Discord webhook (ADR 018).',
    description:
      "Manual ops primitive — admin picks one of the three channels (`orders`, `monitoring`, `admin-audit`), backend posts a test embed at the corresponding webhook URL. A 200 means delivery was attempted (webhook sends are fire-and-forget per ADR 018); a 409 `WEBHOOK_NOT_CONFIGURED` means the channel's env var is unset, so the UI can show 'webhook not configured' instead of a silent success. Tight 10/min rate limit because this is a manual primitive and spamming would be indistinguishable from webhook-URL enumeration.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              channel: z.enum(['orders', 'monitoring', 'admin-audit']),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Delivery attempted; ping sent to the channel',
        content: {
          'application/json': {
            schema: z.object({
              status: z.literal('delivered'),
              channel: z.enum(['orders', 'monitoring', 'admin-audit']),
            }),
          },
        },
      },
      400: {
        description: 'Body missing or channel unknown',
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
        description: "The channel's webhook env var is unset (WEBHOOK_NOT_CONFIGURED)",
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts.csv',
    summary: 'CSV export of pending_payouts (ADR 015).',
    description:
      'Finance-ready CSV of pending_payouts rows in a time window — monthly reconciliation against the Stellar ledger. Default window is 31 days; pass `?since=<iso-8601>` to override. Capped at 366 days and 10 000 rows — past 10 000, the response emits a trailing `__TRUNCATED__` sentinel row and log-warns the real rowCount. `Cache-Control: private, no-store` + `Content-Disposition: attachment` so the browser drops it straight to disk.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row lists every pending_payouts column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for amount_stroops; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/audit-tail.csv',
    summary: 'CSV export of admin write-audit trail (ADR 017 / 018).',
    description:
      'Finance / legal CSV of `admin_idempotency_keys` rows in a time window, joined to `users` for the actor email. SOC-2 / compliance export: a neutral-format dump of "who did what, when" that ops can hand to auditors without exposing the stored response bodies. Default window 31 days, capped at 366. Row cap 10 000 — past the cap, a trailing `__TRUNCATED__` sentinel row signals the window needs narrowing (and the handler log-warns the real rowCount). `Cache-Control: private, no-store` + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row: actor_user_id, actor_email, method, path, status, idempotency_key, created_at. ISO-8601 for the timestamp; response bodies intentionally omitted.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders.csv',
    summary: 'CSV export of Loop-native orders (ADR 011 / 015).',
    description:
      'Finance-ready CSV of `orders` rows in a time window. Month-end reconciliation: face-value totals against the CTX invoice, user-cashback totals against the ledger accrual feed, loop-margin totals against P&L. Default window 31 days, capped at 366 days. Row cap 10 000 — past that, a `__TRUNCATED__` sentinel row trails the output and the handler log-warns the real rowCount. Gift-card fields (redeem_code / redeem_pin / redeem_url) are omitted — this export is for reconciliation, not redemption.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated lines. Header row lists every exposed orders column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for all `*_minor` columns; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/stuck-orders',
    summary: 'Orders stuck in paid/procuring past a threshold (ADR 011 / 013).',
    description:
      'Returns non-terminal orders (state `paid` or `procuring`) older than `?thresholdMinutes=` (default 5, max 10 080). Admin dashboard polls this as its SLO red-flag card — any row landing here means the CTX procurement worker is lagging or an upstream call is hung. Fulfilled / failed / expired rows are terminal and never appear.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        thresholdMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Stuck rows (oldest first) plus the threshold used',
        content: { 'application/json': { schema: StuckOrdersResponse } },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/stuck-payouts',
    summary: 'Payouts stuck in pending/submitted past a threshold (ADR 015 / 016).',
    description:
      "Parallel to `/api/admin/stuck-orders`: returns `pending_payouts` rows in non-terminal state (`pending` or `submitted`) older than `?thresholdMinutes=` (default 5, max 10 080). Ops dashboards poll this alongside stuck-orders — a stuck `submitted` row usually means the Horizon confirmation watcher hasn't seen the tx land. Failed rows are deliberately excluded (they're terminal; review at `/api/admin/payouts?state=failed`).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        thresholdMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Stuck rows (oldest first) plus the threshold used',
        content: { 'application/json': { schema: StuckPayoutsResponse } },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-activity',
    summary: 'Daily cashback-accrual time-series (ADR 009 / 015).',
    description:
      'Dense day-by-day series of cashback credit_transactions for the admin dashboard sparkline. Every day in the window has a row (zero-activity days emit `count: 0, byCurrency: []`). `?days=` overrides the default 30-day window, clamped 1..180.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily rows (oldest → newest)',
        content: { 'application/json': { schema: CashbackActivityResponse } },
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
      500: {
        description: 'Internal error computing the series',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization',
    summary: 'Cashback realization rate — the flywheel-health KPI (ADR 009 / 015).',
    description:
      'Per-currency + fleet-wide aggregate of lifetime cashback emitted, spent on new Loop orders, withdrawn off-ledger, plus outstanding off-chain liability. `recycledBps = spent / earned × 10 000` — the share of emitted cashback that has flowed back into new orders. High realization = flywheel turning; low realization = cashback sitting as stagnant liability. Zero-earned currencies are omitted from per-currency rows but the aggregate row always ships (`currency: null`).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-currency rows + a fleet-wide aggregate',
        content: { 'application/json': { schema: CashbackRealizationResponse } },
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
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization/daily',
    summary: 'Daily cashback-realization trend (ADR 009 / 015).',
    description:
      "Drift-over-time companion to `/api/admin/cashback-realization`. Per-(day, currency) rows with `earnedMinor`, `spentMinor`, and `recycledBps`. `generate_series` LEFT JOIN emits every day in the window even when zero cashback was earned or spent (so sparkline x-axis doesn't compress on gaps). Window: `?days=30` default, 1..180 clamp.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily rows (oldest → newest)',
        content: { 'application/json': { schema: CashbackRealizationDailyResponse } },
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
      500: {
        description: 'Internal error computing the series',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-stats',
    summary: 'Per-merchant cashback stats (ADR 011 / 015).',
    description:
      "Groups fulfilled orders in the window by (merchant, currency). Each row carries order count, face-value total, wholesale cost, user cashback, loop margin, and the most-recent fulfilled timestamp. Sorted by `user_cashback_minor` descending — highest-cashback merchants surface first. Default window 31 days, capped at 366. Distinct from `/api/admin/supplier-spend`, which groups by currency only; this one is the 'which merchants drive the business' view.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rows, highest cashback first',
        content: { 'application/json': { schema: MerchantStatsResponse } },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — per-merchant fulfilled-order flows (ADR 011 / 015) ─────────────

  const MerchantFlow = registry.register(
    'MerchantFlow',
    z.object({
      merchantId: z.string(),
      currency: z.string().openapi({ description: 'ISO charge currency for this bucket.' }),
      count: z.string().openapi({
        description: 'Number of fulfilled orders in this bucket. BigInt-string count.',
      }),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string().openapi({ description: 'Total paid to CTX (supplier).' }),
      userCashbackMinor: z.string().openapi({ description: 'Total credited to users.' }),
      loopMarginMinor: z.string().openapi({ description: 'Total kept by Loop.' }),
    }),
  );

  const MerchantFlowsResponse = registry.register(
    'MerchantFlowsResponse',
    z.object({ flows: z.array(MerchantFlow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-flows',
    summary: 'Aggregated fulfilled-order flow per (merchant, charge currency) (ADR 011 / 015).',
    description:
      "Groups `orders` WHERE `state='fulfilled'` by `merchant_id` + `charge_currency`, summing face/wholesale/cashback/margin. Feeds the per-row 'actual vs configured' display on /admin/cashback so ops can spot merchants whose real split doesn't match their configured cashback.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-merchant flow buckets',
        content: { 'application/json': { schema: MerchantFlowsResponse } },
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

  // ─── Admin — ledger reconciliation (ADR 009) ────────────────────────────────

  const ReconciliationEntry = registry.register(
    'ReconciliationEntry',
    z.object({
      userId: z.string().uuid(),
      currency: z.string(),
      balanceMinor: z.string().openapi({
        description: 'Materialised balance from user_credits.balance_minor. BigInt-string.',
      }),
      ledgerSumMinor: z.string().openapi({
        description:
          'Sum of credit_transactions.amount_minor for this (user, currency). BigInt-string.',
      }),
      deltaMinor: z.string().openapi({
        description: 'balance - ledger_sum. Non-zero by construction (drift query filters on !=).',
      }),
    }),
  );

  const ReconciliationResponse = registry.register(
    'ReconciliationResponse',
    z.object({
      rowCount: z.string().openapi({
        description:
          'Total user_credits rows across all users and currencies. A multi-currency user contributes one row per currency — this is NOT a distinct-user count (A2-907). BigInt-string.',
      }),
      driftedCount: z.string().openapi({
        description:
          'Number of drifted rows returned in `drift`. Capped at 100 — more may exist beyond.',
      }),
      drift: z.array(ReconciliationEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/reconciliation',
    summary: 'Ledger-integrity drift check (ADR 009).',
    description:
      "Joins `user_credits` against the grouped sum of `credit_transactions` per (user_id, currency) and returns any rows where they disagree. A healthy deployment returns an empty `drift` array. The `driftedCount` is capped at 100 to keep responses bounded; a catastrophic divergence surfaces but isn't exhaustively listed.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Drift report',
        content: { 'application/json': { schema: ReconciliationResponse } },
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
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — user search (ADR 011) ──────────────────────────────────────────

  const AdminUserSearchResult = registry.register(
    'AdminUserSearchResult',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']),
      createdAt: z.string().datetime(),
    }),
  );

  const AdminUserSearchResponse = registry.register(
    'AdminUserSearchResponse',
    z.object({
      users: z.array(AdminUserSearchResult),
      truncated: z.boolean().openapi({
        description:
          'True when more matches exist beyond the 20-row cap. Hint for the caller to narrow the query.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/search',
    summary: 'Find users by email fragment (ADR 011).',
    description:
      'Case-insensitive email substring match (ILIKE). Minimum 2 chars, maximum 254 (RFC 5321 email length cap). Ordered by createdAt DESC, limit 20. Returns `truncated: true` when more matches exist beyond the cap. Wildcards (% / _) in the query are escaped so they match literally.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        q: z
          .string()
          .min(2)
          .max(254)
          .openapi({ description: 'Email substring — case-insensitive. 2-254 chars.' }),
      }),
    },
    responses: {
      200: {
        description: 'Search results',
        content: { 'application/json': { schema: AdminUserSearchResponse } },
      },
      400: {
        description: 'q missing, too short, or too long',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — cashback-config CRUD (ADR 011) ─────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs',
    summary: 'List every merchant cashback-split config (ADR 011).',
    description:
      'Returns one row per configured merchant with the three split percentages + active flag + last-updated-by. Rows are ordered by merchantId so the admin UI renders a stable list across reloads.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Cashback configs',
        content: { 'application/json': { schema: AdminCashbackConfigListResponse } },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs.csv',
    summary: 'CSV export of merchant cashback-split configs (ADR 011 / 018).',
    description:
      "Tier-3 bulk export per ADR 018 — finance / audit consumes the snapshot in a spreadsheet. Columns: merchant_id, merchant_name, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by, updated_at. Merchant-name falls back to merchant_id for rows whose merchant has evicted from the catalog (ADR 021 Rule A). Active serialises as the literal 'true' / 'false' so spreadsheet filters don't fight blanks. RFC 4180 (CRLF + quote-escape). Row cap 10 000 with a trailing `__TRUNCATED__` row on overflow — practically unreachable here (~hundreds of configs) but kept uniform with the other admin CSVs. 10/min rate limit.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV snapshot of all cashback-config rows',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              example:
                'merchant_id,merchant_name,wholesale_pct,user_cashback_pct,loop_margin_pct,active,updated_by,updated_at\r\namazon,Amazon,70.00,25.00,5.00,true,admin-abc,2026-04-22T14:00:00.000Z\r\n',
            }),
          },
        },
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the CSV',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs/history',
    summary: 'Fleet-wide cashback-config history feed (ADR 011 / 018).',
    description:
      "Newest-first view of every cashback-config edit across every merchant — the 'recent config changes' strip on the admin dashboard. Complement to the per-merchant drill (`/:merchantId/history`); this one doesn't require picking a merchant first. Merchant names enrich from the catalog and fall back to `merchantId` for evicted rows (ADR 021 Rule A). `?limit=` defaults 50, clamped [1, 200].",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Newest-first audit rows across all merchants',
        content: {
          'application/json': {
            schema: z.object({
              history: z.array(
                z.object({
                  id: z.string().uuid(),
                  merchantId: z.string(),
                  merchantName: z.string(),
                  wholesalePct: z.string(),
                  userCashbackPct: z.string(),
                  loopMarginPct: z.string(),
                  active: z.boolean(),
                  changedBy: z.string(),
                  changedAt: z.string().datetime(),
                }),
              ),
            }),
          },
        },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading history',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/admin/merchant-cashback-configs/{merchantId}',
    summary: 'Upsert a merchant cashback-split config (ADR 011 / ADR 017).',
    description:
      'INSERT on first touch, UPDATE otherwise. A Postgres trigger appends the pre-edit values to `merchant_cashback_config_history` so every change is auditable by `admin_user_id` + timestamp. A2-502: ADR-017 admin-write contract — `Idempotency-Key` header required, `reason` required in the body, response is the standard `{ result, audit }` envelope. A repeat PUT with the same actor+key replays the stored snapshot (`audit.replayed: true`).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      headers: z.object({
        'idempotency-key': z.string().min(16).max(128).openapi({
          description:
            'ADR 017 idempotency key — a UUID or any 16..128-char opaque token the client generates per click.',
        }),
      }),
      body: { content: { 'application/json': { schema: UpsertCashbackConfigBody } } },
    },
    responses: {
      200: {
        description: 'Updated row wrapped in the ADR-017 {result, audit} envelope',
        content: { 'application/json': { schema: AdminCashbackConfigEnvelope } },
      },
      400: {
        description:
          'Invalid body / missing Idempotency-Key / missing reason / percentages out of range / sum > 100 / malformed merchantId',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'DB write failed',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs/{merchantId}/history',
    summary: 'Audit-log history for one merchant cashback config (ADR 011).',
    description:
      'Up to 50 most-recent prior-state snapshots for a single merchant, newest first. Each row captures the exact values at the time of the change and who made it.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
    },
    responses: {
      200: {
        description: 'History rows (bounded to 50)',
        content: { 'application/json': { schema: AdminCashbackConfigHistoryResponse } },
      },
      400: {
        description: 'Missing merchantId',
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
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin per-merchant drill metrics (ADR 011/015/022) ────────────────────
  //
  // Scalar-per-merchant trio that backs the /admin/merchants/:id drill-down.
  // See ADR-022 for the triplet pattern — these are the per-merchant axis of
  // the fleet + per-merchant + per-user + self quartet shipped around the
  // cashback-flywheel pivot.

  const AdminMerchantFlywheelStats = registry.register(
    'AdminMerchantFlywheelStats',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime().openapi({ description: 'Window start — 31 days ago.' }),
      totalFulfilledCount: z.number().int(),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over loop_asset orders. bigint-as-string.',
      }),
      totalChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over every fulfilled order. bigint-as-string.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-stats',
    summary: 'Per-merchant recycled-vs-total scalar (ADR 011 / 015).',
    description:
      'Drives the flywheel chip on the merchant drill. 31-day fixed window, home-currency-agnostic at the merchant axis. Zero-volume merchants return zeroed fields (not 404) — a catalog merchant with no orders yet is a valid row.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-merchant flywheel scalar',
        content: { 'application/json': { schema: AdminMerchantFlywheelStats } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'DB error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const AdminMerchantCashbackCurrencyBucket = registry.register(
    'AdminMerchantCashbackCurrencyBucket',
    z.object({
      currency: z.string().length(3),
      fulfilledCount: z.number().int(),
      lifetimeCashbackMinor: z.string().openapi({
        description:
          'SUM(user_cashback_minor) over fulfilled orders in this currency. bigint-as-string.',
      }),
      lifetimeChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) in this currency — context for "cashback as % of spend".',
      }),
    }),
  );

  const AdminMerchantCashbackSummary = registry.register(
    'AdminMerchantCashbackSummary',
    z.object({
      merchantId: z.string(),
      totalFulfilledCount: z.number().int(),
      currencies: z.array(AdminMerchantCashbackCurrencyBucket).openapi({
        description:
          'One entry per charge currency the merchant has seen. Sorted desc by fulfilledCount. Multi-row because per-merchant volume spans user home_currencies (no coherent rolled-up denomination).',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/cashback-summary',
    summary: 'Per-currency lifetime cashback paid out on a merchant (ADR 009 / 011 / 015).',
    description:
      'Sourced from orders.user_cashback_minor (pinned at creation) rather than credit_transactions, so the number is stable even when a ledger row is delayed. Only state=fulfilled counts. Zero-volume merchants return empty currencies[], not 404.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-currency cashback summary for the merchant',
        content: { 'application/json': { schema: AdminMerchantCashbackSummary } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'DB error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PaymentMethodBucketShape = z.object({
    orderCount: z.number().int(),
    chargeMinor: z.string().openapi({
      description: 'SUM(charge_minor) for this (state, method) bucket. bigint-as-string.',
    }),
  });

  const MerchantPaymentMethodShareResponse = registry.register(
    'MerchantPaymentMethodShareResponse',
    z.object({
      merchantId: z.string(),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z
        .object({
          xlm: PaymentMethodBucketShape,
          usdc: PaymentMethodBucketShape,
          credit: PaymentMethodBucketShape,
          loop_asset: PaymentMethodBucketShape,
        })
        .openapi({
          description:
            'Zero-filled across every known ORDER_PAYMENT_METHODS value so the admin UI layout stays stable across merchants with incomplete rail coverage.',
        }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/payment-method-share',
    summary: 'Per-merchant rail mix (ADR 010 / 015).',
    description:
      'Drives the "rail mix" card on the merchant drill. Merchant-scoped mirror of /api/admin/orders/payment-method-share — same zero-filled byMethod shape, filtered via WHERE merchant_id = :merchantId. Default ?state=fulfilled.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rail mix',
        content: { 'application/json': { schema: MerchantPaymentMethodShareResponse } },
      },
      400: {
        description: 'Malformed merchantId or invalid ?state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'DB error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin per-merchant time-series (ADR 011/015/022) ──────────────────────
  //
  // Second backfill batch (see #668 for the scalar batch). Time-series
  // companions to the per-merchant scalars — same drill page, same
  // merchantId path parameter, but with arrays keyed on day/month/user.

  const AdminMerchantCashbackMonthlyEntry = registry.register(
    'AdminMerchantCashbackMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      currency: z.string().length(3),
      cashbackMinor: z.string().openapi({ description: 'bigint-as-string, minor units.' }),
    }),
  );

  const AdminMerchantCashbackMonthlyResponse = registry.register(
    'AdminMerchantCashbackMonthlyResponse',
    z.object({
      merchantId: z.string(),
      entries: z.array(AdminMerchantCashbackMonthlyEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/cashback-monthly',
    summary: 'Per-merchant 12-month cashback emission trend (ADR 009/011/015).',
    description:
      'Scalar cashback-paid-out (see /cashback-summary) answers "how much total?"; this time-series answers "is it growing?". 12-month fixed window bucketed on fulfilled_at, sourced from orders.user_cashback_minor. Zero-volume merchants return empty entries[] (not 404).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-(month, currency) cashback minted at the merchant',
        content: { 'application/json': { schema: AdminMerchantCashbackMonthlyResponse } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const MerchantFlywheelActivityDay = registry.register(
    'MerchantFlywheelActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      recycledCount: z.number().int(),
      totalCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  const MerchantFlywheelActivityResponse = registry.register(
    'MerchantFlywheelActivityResponse',
    z.object({
      merchantId: z.string(),
      days: z.number().int().openapi({ description: 'Window size — default 30, max 180.' }),
      rows: z.array(MerchantFlywheelActivityDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-activity',
    summary: 'Per-merchant daily flywheel trajectory (ADR 011/015).',
    description:
      'Time-axis companion to /flywheel-stats — scalar answers "what is the share?", this answers "is it trending up?". generate_series LEFT JOIN zero-fills every day. Bucketed on fulfilled_at::date. Only state=fulfilled counts.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily recycled-vs-total series for the merchant',
        content: { 'application/json': { schema: MerchantFlywheelActivityResponse } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const MerchantTopEarnerRow = registry.register(
    'MerchantTopEarnerRow',
    z.object({
      userId: z.string().uuid(),
      email: z.string(),
      currency: z.string().length(3),
      orderCount: z.number().int(),
      cashbackMinor: z.string().openapi({
        description: 'SUM(user_cashback_minor) for this (user, currency). bigint-as-string.',
      }),
      chargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) — context for "cashback as % of their spend".',
      }),
    }),
  );

  const MerchantTopEarnersResponse = registry.register(
    'MerchantTopEarnersResponse',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime(),
      rows: z.array(MerchantTopEarnerRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/top-earners',
    summary: 'Top cashback earners at a merchant (ADR 009/011/015).',
    description:
      'Inverse axis of /api/admin/users/:userId/cashback-by-merchant — answers "who earns at Amazon?" rather than "where does Alice earn?". BD outreach surface. Joins users for email enrichment (admin-gated, PII exposure fine). Multi-currency: one user can appear twice if they have fulfilled orders at the merchant in two charge currencies.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked list of users by cashback earned at the merchant',
        content: { 'application/json': { schema: MerchantTopEarnersResponse } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  // ─── Admin per-user drill metrics (ADR 009/015/022) ────────────────────────
  //
  // Per-user axis of the triplet pattern — recovers content from the
  // auto-closed #670 (its stacked base branch was deleted during cascade
  // merge) plus ships the batch 4 CSV siblings and the fleet payouts pair
  // in one coherent PR.

  const AdminUserFlywheelStats = registry.register(
    'AdminUserFlywheelStats',
    z.object({
      userId: z.string().uuid(),
      currency: z.string().length(3).openapi({
        description:
          "Target user's home_currency — both numerator and denominator share it so the ratio has a coherent denomination.",
      }),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalFulfilledCount: z.number().int(),
      totalFulfilledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/flywheel-stats',
    summary: 'Per-user recycled-vs-total scalar (ADR 015).',
    description:
      "Admin-scoped mirror of /api/users/me/flywheel-stats. 404 on unknown userId (distinguishes 'user not in DB' from 'user with no fulfilled orders' which returns zeroed counts). Home-currency-locked.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Per-user flywheel scalar',
        content: { 'application/json': { schema: AdminUserFlywheelStats } },
      },
      400: {
        description: 'Malformed userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const AdminUserCashbackMonthlyEntry = registry.register(
    'AdminUserCashbackMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      currency: z.string().length(3),
      cashbackMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  const AdminUserCashbackMonthlyResponse = registry.register(
    'AdminUserCashbackMonthlyResponse',
    z.object({
      userId: z.string().uuid(),
      entries: z.array(AdminUserCashbackMonthlyEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-monthly',
    summary: 'Per-user 12-month cashback emission trend (ADR 009/015).',
    description:
      'Admin-scoped per-user sibling of /api/admin/cashback-monthly. 12-month window on credit_transactions of type=cashback. Existence probe separates 404 (unknown userId) from empty entries[] (exists, no cashback in window).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Per-(month, currency) cashback for the user',
        content: { 'application/json': { schema: AdminUserCashbackMonthlyResponse } },
      },
      400: {
        description: 'Malformed userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const UserPaymentMethodShareResponse = registry.register(
    'UserPaymentMethodShareResponse',
    z.object({
      userId: z.string().uuid(),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z.object({
        xlm: PaymentMethodBucketShape,
        usdc: PaymentMethodBucketShape,
        credit: PaymentMethodBucketShape,
        loop_asset: PaymentMethodBucketShape,
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/payment-method-share',
    summary: 'Per-user rail mix (ADR 010/015).',
    description:
      'Admin-scoped per-user sibling of the per-merchant payment-method-share (#668). Default ?state=fulfilled. Zero-filled byMethod. Support-triage: "does this user only pay with LOOP asset?" vs "never touched it?".',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-user rail mix',
        content: { 'application/json': { schema: UserPaymentMethodShareResponse } },
      },
      400: {
        description: 'Malformed userId or invalid ?state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  // ─── Admin CSV exports (ADR 018 Tier-3) ─────────────────────────────────────
  //
  // Content-type text/csv; charset=utf-8 — no JSON schema because the body
  // is raw CSV text. Generated clients learn the endpoint exists + query
  // params + error shapes. ADR 018 conventions: RFC 4180, 10k-row cap with
  // __TRUNCATED__ sentinel, 10/min rate, Cache-Control: private, no-store.

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization/daily.csv',
    summary: 'Daily cashback-realization trend CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-realization/daily. Columns: day,currency,earned_minor,spent_minor,recycled_bps. LEFT-JOIN null-currency rows are dropped pre-truncation so the row cap counts real signal. Window: ?days (default 31, cap 366). Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-activity.csv',
    summary: 'Daily cashback accrual as RFC 4180 CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-activity. Columns: day,currency,cashback_count,cashback_minor. Zero-activity days emit day,,,0,0. Window: ?days (default 31, cap 366). Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-activity.csv',
    summary:
      'Daily confirmed-payout CSV — settlement counterpart to cashback-activity.csv (ADR 015/016/018).',
    description:
      'Tier-3 CSV of /api/admin/payouts-activity. Columns: day,asset_code,payout_count,stroops. Zero days emit day,,0,0. Bucketed on confirmed_at::date. Window: ?days (default 31, cap 366).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-activity.csv',
    summary: 'Per-merchant flywheel-activity CSV for BD/commercial prep (ADR 011/015/018).',
    description:
      "Tier-3 CSV of /api/admin/merchants/:merchantId/flywheel-activity. Columns: day,recycled_count,total_count,recycled_charge_minor,total_charge_minor. Filename includes merchantId so multi-merchant BD pulls don't collide.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants-catalog.csv',
    summary: 'Full merchant catalog + cashback-config state as CSV (ADR 011/018).',
    description:
      'Tier-3 CSV of the in-memory catalog joined against merchant_cashback_configs. Columns: merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at. Merchants without a config emit empty config columns ("no config yet" — distinct from active=false). Catalog is source of truth; evicted merchants drop out.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/supplier-spend/activity.csv',
    summary: 'Daily × per-currency supplier-spend CSV (ADR 013/015/018).',
    description:
      "Tier-3 CSV of /api/admin/supplier-spend/activity. Columns: day,currency,count,face_value_minor,wholesale_minor,user_cashback_minor,loop_margin_minor. Finance runs this at month-end to reconcile CTX's invoice — wholesale_minor per (day, currency) should tie to CTX's line items. Zero-activity days emit day,,0,0,0,0,0. Window: ?days (default 31, cap 366). Row cap 10 000.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Unknown `currency`',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury/credit-flow.csv',
    summary: 'Daily × per-currency credit-flow CSV (ADR 009/015/018).',
    description:
      'Tier-3 CSV of /api/admin/treasury/credit-flow. Columns: day,currency,credited_minor,debited_minor,net_minor. Completes the finance-CSV quartet (cashback-activity, payouts-activity, supplier-spend/activity, this). Zero-activity days emit day,,0,0,0. With ?currency the LEFT JOIN generate_series gives a dense series. Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Unknown `currency`',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury.csv',
    summary: 'Treasury snapshot CSV for SOC-2 / audit evidence (ADR 009/015/018).',
    description:
      'Point-in-time long-form CSV of the same aggregate /api/admin/treasury serves. Columns: metric,key,value. Metric vocabulary: snapshot_taken_at, outstanding, ledger_total, liability, liability_issuer, asset_stroops, payout_state, operator, operator_pool_size. Successive snapshots diff cleanly in audit tooling — auditors can eyeball which field moved between evidence runs. Reuses the JSON snapshot handler so no aggregate drift.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/operators-snapshot.csv',
    summary: 'Per-operator fleet snapshot CSV for CTX reviews (ADR 013/018/022).',
    description:
      'Tier-3 CSV joining operator-stats + operator-latency into one row per operator. Columns: operator_id,order_count,fulfilled_count,failed_count,success_pct,sample_count,p50_ms,p95_ms,p99_ms,mean_ms,last_order_at. Handed to CTX relationship owners for quarterly review meetings — SLA + volume + success rate on one sheet. Stats is the LEFT side: operators with orders but no fulfilled-with-timings samples get zero-filled latency columns. ?since default 24h, cap 366d.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Invalid or out-of-window `since`',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  // ─── Admin fleet-wide monthly / daily (ADR 015/016) ─────────────────────────

  const AdminPayoutsMonthlyEntry = registry.register(
    'AdminPayoutsMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      assetCode: z.string().openapi({
        description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP or future additions.',
      }),
      paidStroops: z.string().openapi({ description: 'bigint-as-string stroops.' }),
      payoutCount: z.number().int(),
    }),
  );

  const AdminPayoutsMonthlyResponse = registry.register(
    'AdminPayoutsMonthlyResponse',
    z.object({ entries: z.array(AdminPayoutsMonthlyEntry) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-monthly',
    summary: 'Settlement counterpart to /cashback-monthly (ADR 015/016).',
    description:
      'Fixed 12-month window; filter state=confirmed; bucket on (month, assetCode). Pair with /cashback-monthly to answer "is outstanding LOOP-asset liability growing or shrinking this month?". bigint-as-string on paidStroops.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-(month, assetCode) confirmed-payout totals',
        content: { 'application/json': { schema: AdminPayoutsMonthlyResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const PerAssetPayoutAmount = registry.register(
    'PerAssetPayoutAmount',
    z.object({
      assetCode: z.string(),
      stroops: z.string().openapi({ description: 'bigint-as-string.' }),
      count: z.number().int(),
    }),
  );

  const PayoutsActivityDay = registry.register(
    'PayoutsActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      count: z.number().int(),
      byAsset: z.array(PerAssetPayoutAmount),
    }),
  );

  const PayoutsActivityResponse = registry.register(
    'PayoutsActivityResponse',
    z.object({
      days: z.number().int(),
      rows: z.array(PayoutsActivityDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-activity',
    summary:
      'Daily confirmed-payout sparkline — settlement sibling of cashback-activity (ADR 015/016).',
    description:
      'generate_series LEFT JOIN zero-fills every day. Bucketed on confirmed_at::date. ?days default 30, max 180. Per (day, assetCode) so UI can render per-asset sparklines. bigint-as-string on stroops.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily confirmed-payout series',
        content: { 'application/json': { schema: PayoutsActivityResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  // A2-506: 8 non-CSV admin endpoints were missing from the OpenAPI
  // surface. Each handler's own TypeScript response interface is the
  // authoritative wire shape; these registrations carry the route
  // identity, auth contract, and error ladder so generated clients
  // + the admin Swagger preview see them. The response schemas use
  // `z.unknown()` for the body payload — the TS interface in the
  // handler file is the source of truth for the row shape; OpenAPI
  // callers read the doc comment for column-level detail. A follow-up
  // could mirror each interface into a zod schema, but parity with
  // TS would need a single-source-of-truth machinery we don't have
  // today.

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders',
    summary: 'Paginated admin view of orders (ADR 010 / 018).',
    description:
      "Fleet-wide orders list for the admin drill. Supports `?state=`, `?merchantId=`, `?userId=`, `?before=<iso>`, `?limit=` (default 20, cap 100) for paging. Returns the orders alongside user/merchant context resolved server-side so the admin UI doesn't need per-row round-trips.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z.string().optional(),
        merchantId: z.string().optional(),
        userId: z.string().uuid().optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Page of orders + pagination cursor',
        content: { 'application/json': { schema: z.unknown() } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/payment-method-activity',
    summary: 'Fleet payment-method-share activity per day (ADR 015 / 018).',
    description:
      'Daily bucketed counts and charge totals grouped by payment method (credit, loop_asset, usdc, xlm) — powers the rail-mix activity chart on /admin/cashback. Window: `?days=N` (default 30, cap 180).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day payment-method activity',
        content: { 'application/json': { schema: z.unknown() } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-monthly',
    summary: 'Fleet-wide monthly cashback aggregate (ADR 009 / 015).',
    description:
      'Monthly sum of cashback credited across all users in the last 12 months, grouped by currency. Drives the admin dashboard headline. Self-scoped — a user-drill variant lives at `/api/users/me/cashback-monthly`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '12-month cashback buckets',
        content: { 'application/json': { schema: z.unknown() } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-stats.csv',
    summary: 'CSV export of per-merchant fleet statistics (ADR 011 / 018).',
    description:
      'Finance-ready CSV of per-merchant order volume, cashback paid, margin, and activity. `Cache-Control: private, no-store` + `Content-Disposition: attachment`. Row cap 10 000 with `__TRUNCATED__` sentinel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row lists every merchant-stats column. bigint amounts emitted as strings.',
            }),
          },
        },
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share',
    summary: 'Fleet flywheel share per merchant (ADR 015).',
    description:
      "Per-merchant breakdown of recycled vs non-recycled orders over a window — what share of each merchant's volume comes from LOOP-asset (cashback-recycled) payments. Window: `?days=N` (default 30, cap 180).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant flywheel share',
        content: { 'application/json': { schema: z.unknown() } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share.csv',
    summary: 'CSV export of per-merchant flywheel share (ADR 015 / 018).',
    description:
      'Downloadable CSV companion to `/api/admin/merchants/flywheel-share` — same columns and windowing. `Cache-Control: private, no-store` + `Content-Disposition: attachment`. Row cap 10 000 with `__TRUNCATED__` sentinel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description: 'Header: merchantId, merchantName, recycled_count, total_count, pct.',
            }),
          },
        },
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
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-by-merchant',
    summary: 'User-drill: cashback earned per merchant (ADR 009).',
    description:
      'Per-merchant breakdown of cashback one user has earned in a window. Companion to `/api/users/me/cashback-by-merchant`; admin-scoped by userId param.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant cashback rows for the target user',
        content: { 'application/json': { schema: z.unknown() } },
      },
      400: {
        description: 'Malformed userId',
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
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-summary',
    summary: 'User-drill: lifetime + this-month cashback summary (ADR 009 / 015).',
    description:
      'Admin-scoped mirror of `/api/users/me/cashback-summary`. Returns lifetime + month-to-date cashback for the target user, denominated in their current home currency. Used on `/admin/users/:userId` as the compact headline above the ledger drill.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Cashback summary for the target user',
        content: { 'application/json': { schema: z.unknown() } },
      },
      400: {
        description: 'Malformed userId',
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
      404: {
        description: 'Target user not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/recycling-activity.csv',
    summary: 'CSV export of per-user recycling activity (ADR 015).',
    description:
      'One row per user in the fleet-wide flywheel view: total charge, recycled charge, cashback, order counts, and most-recent activity timestamp. Default window is 31 days; pass `?days=N` to override (cap 366). Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` (PII: user ids + emails) + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated. Header row lists every recycling-activity column; bigint charges emitted as strings to survive JSON round-trips in downstream tooling.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `days` (out of range 1..366)',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // A2-506 residual — JSON variant of recycling-activity. The CSV
  // shipped its registration; the JSON-returning sibling at
  // `app.ts:1585` was missed in the original wave.
  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/recycling-activity',
    summary: 'Top-N most-recent flywheel-active users (ADR 015).',
    description:
      'Ranked list of users who have placed at least one `loop_asset` paid order in the rolling 90-day window, ordered by most-recent recycle. Zero-recycle users are omitted (the signal is "who is in the loop", not the full directory). `?limit=` clamp 1..100, default 25. `Cache-Control: private, no-store` (per-user data).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Recycling-activity rows',
        content: {
          'application/json': {
            schema: z
              .object({
                since: z.string().openapi({ format: 'date-time' }),
                rows: z.array(
                  z.object({
                    userId: z.string(),
                    email: z.string(),
                    lastRecycledAt: z.string().openapi({ format: 'date-time' }),
                    recycledOrderCount: z.number().int().nonnegative(),
                    recycledChargeMinor: z.string().openapi({
                      description:
                        'Bigint-as-string — sum of charge_minor over loop_asset orders in window.',
                    }),
                    currency: z.string(),
                  }),
                ),
              })
              .openapi('AdminUsersRecyclingActivityResponse'),
          },
        },
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
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/user-credits.csv',
    summary: 'CSV export of user_credits balances (ADR 009).',
    description:
      'One row per `(user_id, currency)` credit balance, joined to `users.email`. Finance uses this to audit total off-chain liability per currency or to pull a list of balance-holders. Ordered by currency then balance desc so a "top holders" audit is the natural read order. Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` (PII: email) + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row: `User ID, Email, Currency, Balance (minor), Updated at (UTC)`. Balance emitted as bigint-string to preserve precision.',
            }),
          },
        },
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
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/credit-transactions.csv',
    summary: "CSV export of one user's credit-transactions ledger (ADR 009).",
    description:
      'Full credit-ledger stream for a single user in a window — support / legal use it for a user dispute or a subject-access-request. Default window is 366 days; pass `?since=<iso-8601>` to override (cap 366 days). Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` + `Content-Disposition: attachment; filename="credit-transactions-<userTail>-<date>.csv"`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row: `id, type, amount_minor, currency, reference_type, reference_id, created_at`. bigint-as-string for amount_minor; ISO-8601 for created_at.',
            }),
          },
        },
      },
      400: {
        description: 'Malformed userId, invalid `since`, or window over 366 days',
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
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
