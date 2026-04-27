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
import { registerAdminOrderClusterOpenApi } from './admin-order-cluster.js';
import { registerAdminPayoutsClusterOpenApi } from './admin-payouts-cluster.js';
import { registerAdminPerMerchantDrillOpenApi } from './admin-per-merchant-drill.js';
import { registerAdminPerUserDrillOpenApi } from './admin-per-user-drill.js';
import { registerAdminSupplierSpendOpenApi } from './admin-supplier-spend.js';
import { registerAdminUserClusterOpenApi } from './admin-user-cluster.js';

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

  // ─── Admin payouts cluster (ADR 015/016/017/024) ───────────────────────────
  //
  // Six paths backing /admin/payouts (list, single-row drill,
  // by-asset totals, settlement-lag SLA, retry, compensate) plus
  // their locally-scoped schemas live in
  // ./admin-payouts-cluster.ts. Threaded deps: shared
  // `errorResponse`, plus `PayoutState` (cross-section enum from
  // openapi.ts), `AdminPayoutView` (also reused by
  // ./admin-order-cluster.ts), and `AdminWriteAudit`.
  registerAdminPayoutsClusterOpenApi(
    registry,
    errorResponse,
    PayoutState,
    AdminPayoutView,
    AdminWriteAudit,
  );

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

  // ─── Admin user cluster (ADR 009/015/022) ───────────────────────────────────
  //
  // The six user-directory + per-user read paths (paginated
  // /users, /users/by-email, /users/top-by-pending-payout,
  // /users/{userId}, /users/{userId}/credits,
  // /users/{userId}/credit-transactions) plus their eight
  // locally-scoped schemas live in ./admin-user-cluster.ts.
  registerAdminUserClusterOpenApi(registry, errorResponse);

  // ─── Admin order cluster (ADR 010/011/015/019) ─────────────────────────────
  //
  // The four order-cluster paths (orders/activity,
  // orders/payment-method-share, orders/{id}, orders/{id}/payout)
  // plus their three locally-scoped schemas (AdminOrderState,
  // AdminOrderPaymentMethod, AdminOrderView) live in
  // ./admin-order-cluster.ts. The `AdminPayoutView` schema stays
  // here because it has multiple call sites; threaded as a
  // parameter to the slice.
  registerAdminOrderClusterOpenApi(registry, errorResponse, AdminPayoutView);

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
