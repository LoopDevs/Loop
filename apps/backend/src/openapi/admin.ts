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
import { registerAdminCashbackConfigOpenApi } from './admin-cashback-config.js';
import { registerAdminCreditWritesOpenApi } from './admin-credit-writes.js';
import { registerAdminCsvExportsOpenApi } from './admin-csv-exports.js';
import { registerAdminDashboardClusterOpenApi } from './admin-dashboard-cluster.js';
import { registerAdminFleetMonthlyOpenApi } from './admin-fleet-monthly.js';
import { registerAdminMiscReadsOpenApi } from './admin-misc-reads.js';
import { registerAdminOperatorFleetOpenApi } from './admin-operator-fleet.js';
import { registerAdminOperatorMixOpenApi } from './admin-operator-mix.js';
import { registerAdminPerMerchantDrillOpenApi } from './admin-per-merchant-drill.js';
import { registerAdminPerUserDrillOpenApi } from './admin-per-user-drill.js';
import { registerAdminSupplierSpendOpenApi } from './admin-supplier-spend.js';

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

  // ─── Admin credit-write surfaces (ADR 017/024 + A2-901) ─────────────────────
  //
  // The three admin-mediated writes — credit-adjustment, refund,
  // withdrawal — share the ADR-017 contract (idempotency key,
  // reason, audit envelope). Lifted into ./admin-credit-writes.ts;
  // the nine locally-scoped Body/Result/Envelope schemas travel
  // with it. `AdminWriteAudit` stays here because it is shared
  // with ./admin-cashback-config.ts and is threaded into both
  // slices as a parameter.
  registerAdminCreditWritesOpenApi(registry, errorResponse, AdminWriteAudit);

  // ─── Admin dashboard cluster (ADR 009/011/013/015/016) ──────────────────────
  //
  // Six dashboard-grade signals (stuck-orders / stuck-payouts /
  // cashback-activity / cashback-realization{,/daily} /
  // merchant-stats) backing the /admin landing page. Twelve
  // locally-scoped schemas travel with the slice in
  // ./admin-dashboard-cluster.ts.
  registerAdminDashboardClusterOpenApi(registry, errorResponse);

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

  // ─── Admin supplier-spend & treasury credit-flow (ADR 009/013/015) ──────────
  //
  // The "treasury-velocity triplet" — supplier spend, supplier-spend
  // activity, treasury credit-flow — lives in ./admin-supplier-spend.ts.
  // Locally-scoped schemas (AdminSupplierSpendResponse,
  // AdminSupplierSpendActivityDay/Response,
  // AdminTreasuryCreditFlowDay/Response) travel with the slice.
  // `AdminSupplierSpendRow` stays here because it is shared with
  // ./admin-operator-fleet.ts and is threaded into both slices as a
  // parameter.
  registerAdminSupplierSpendOpenApi(registry, errorResponse, AdminSupplierSpendRow);

  //
  // The three X × operator endpoints (merchants/{id}/operator-mix,
  // operators/{id}/merchant-mix, users/{id}/operator-mix) plus
  // their six locally-scoped schemas live in
  // ./admin-operator-mix.ts. Only `errorResponse` crosses the
  // slice boundary.
  registerAdminOperatorMixOpenApi(registry, errorResponse);

  // ─── Admin operator-fleet (ADR 013/015/022) ─────────────────────────────────
  //
  // Operator-stats / operator-latency / per-operator supplier-spend
  // / per-operator activity — the four paths backing the
  // /admin/operators dashboard. Lifted into ./admin-operator-fleet.ts;
  // the five locally-scoped schemas travel with it. Threaded deps:
  // shared `errorResponse` plus the upstream `AdminSupplierSpendRow`
  // (also reused by the fleet supplier-spend section, so passed in
  // by reference rather than re-declared).
  registerAdminOperatorFleetOpenApi(registry, errorResponse, AdminSupplierSpendRow);

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
  // ─── Admin — cashback-config schemas (ADR 011) ──────────────────────────────
  //
  // Schemas + paths lifted into ./admin-cashback-config.ts; the
  // factory call below registers both. See the section header at
  // the call site for the dep-threading rationale.
  registerAdminCashbackConfigOpenApi(registry, errorResponse, CashbackPctString, AdminWriteAudit);

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

  // The three CSV exports that originally lived here (payouts.csv,
  // audit-tail.csv, orders.csv) are now in ./admin-csv-exports.ts
  // alongside every other admin CSV registration — see the comment
  // above the appended block in that file.

  // ─── Admin — misc reads (merchant-flows / reconciliation / user-search) ─────
  //
  // Three independent ad-hoc admin reads that don't fit the per-
  // merchant or per-user drill triplet. Lifted as one slice into
  // ./admin-misc-reads.ts; the six locally-scoped schemas
  // (MerchantFlow + Response, ReconciliationEntry + Response,
  // AdminUserSearchResult + Response) travel with it.
  registerAdminMiscReadsOpenApi(registry, errorResponse);

  // ─── Admin — cashback-config CRUD (ADR 011) ─────────────────────────────────
  //
  // The five `/api/admin/merchant-cashback-configs*` paths plus
  // their six locally-scoped schemas (AdminCashbackConfig + List /
  // Envelope / Upsert body / History row + Response) live in
  // ./admin-cashback-config.ts. None of those schemas are
  // referenced anywhere else in admin.ts so the slice carries them
  // with it. Threaded deps are the shared `errorResponse`,
  // cross-section `cashbackPctString`, and the upstream
  // `AdminWriteAudit` envelope.

  // ─── Admin per-merchant drill (ADR 011/015/022) ─────────────────────────────
  //
  // Both the scalar batch (flywheel-stats / cashback-summary /
  // payment-method-share) and the time-series companions
  // (cashback-monthly / flywheel-activity / top-earners) live in
  // ./admin-per-merchant-drill.ts. The 11 locally-scoped schemas
  // travel with the slice; only `errorResponse` crosses the
  // boundary.
  registerAdminPerMerchantDrillOpenApi(registry, errorResponse);

  // ─── Admin per-user drill (ADR 009/015/022) ─────────────────────────────────
  //
  // Per-user axis of the ADR-022 triplet — three scalars that back
  // the /admin/users/:id drill page (flywheel-stats /
  // cashback-monthly / payment-method-share). Lifted into
  // ./admin-per-user-drill.ts; the four locally-scoped schemas
  // (AdminUserFlywheelStats, AdminUserCashbackMonthlyEntry/Response,
  // UserPaymentMethodShareResponse) plus the inline
  // PaymentMethodBucketShape constant travel with the slice.
  registerAdminPerUserDrillOpenApi(registry, errorResponse);

  // ─── Admin CSV exports (ADR 018 Tier-3) ─────────────────────────────────────
  //
  // Lifted into ./admin-csv-exports.ts so this file stays under the
  // soft cap. The CSV-export routes form a self-contained group
  // (text/csv body, no JSON schema, single shared dependency on
  // `errorResponse`) so the slice is safe to delegate without
  // reaching back into the admin-local schemas defined above.
  registerAdminCsvExportsOpenApi(registry, errorResponse);

  // ─── Admin fleet-wide monthly / daily (ADR 015/016) ─────────────────────────
  //
  // Lifted into ./admin-fleet-monthly.ts so admin.ts stays under the
  // soft cap. The 13 paths in that slice carry their own response
  // schemas (AdminPayoutsMonthlyEntry / Response, PerAssetPayoutAmount,
  // PayoutsActivityDay / Response) — none of those names are
  // referenced anywhere else in admin.ts, so the section is
  // self-contained modulo the shared `errorResponse` dependency.
  registerAdminFleetMonthlyOpenApi(registry, errorResponse);
}
