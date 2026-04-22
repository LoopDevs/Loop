/**
 * OpenAPI 3.1 spec for the Loop backend, generated from zod schemas.
 *
 * Each schema here mirrors a request- or response-validator that already
 * exists in a handler. Where they drift, the handler's schema is the
 * source of truth for *validation*; this file is the source of truth for
 * *documentation*. Drift is acceptable as long as this file is kept
 * aligned on every PR that changes a handler contract (checklist item in
 * AGENTS.md §Documentation update rules).
 *
 * Served as JSON at `GET /openapi.json`. Intentionally no Swagger UI bundle
 * — the JSON is enough for clients, editor plugins, and `openapi-generator`
 * consumers; serving interactive docs is left for a follow-up if there's
 * demand.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ─── Shared components ──────────────────────────────────────────────────────

const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'Valid email is required' }),
      details: z
        .record(z.string(), z.unknown().openapi({ type: 'object' }))
        .optional()
        .openapi({ type: 'object' }),
      requestId: z.string().optional().openapi({
        description:
          'Echoes the X-Request-Id header. Present on the catch-all 500 response so a bug report can quote one identifier to correlate with Sentry + backend logs; mirrored from the response header, so consumers can still read it from X-Request-Id on any response.',
      }),
    })
    .openapi({ description: 'Standard error body returned for every non-2xx response.' }),
);

const PlatformEnum = z.enum(['web', 'ios', 'android']).openapi({
  description: 'Client platform. Backend maps to the upstream CTX client ID per platform.',
});

// ─── Auth ───────────────────────────────────────────────────────────────────

const RequestOtpBody = registry.register(
  'RequestOtpBody',
  z.object({
    email: z.string().email(),
    platform: PlatformEnum.default('web'),
  }),
);

const VerifyOtpBody = registry.register(
  'VerifyOtpBody',
  z.object({
    email: z.string().email(),
    otp: z.string().min(1),
    platform: PlatformEnum.default('web'),
  }),
);

const VerifyOtpResponse = registry.register(
  'VerifyOtpResponse',
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
  }),
);

const RefreshBody = registry.register(
  'RefreshBody',
  z.object({
    refreshToken: z.string().min(1),
    platform: PlatformEnum.default('web'),
  }),
);

const RefreshResponse = registry.register(
  'RefreshResponse',
  z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional().openapi({
      description: 'Present when upstream rotates the refresh token on refresh.',
    }),
  }),
);

const LogoutBody = registry.register(
  'LogoutBody',
  z.object({
    refreshToken: z.string().optional(),
    platform: PlatformEnum.default('web'),
  }),
);

// ─── Merchants ──────────────────────────────────────────────────────────────

const MerchantDenominations = registry.register(
  'MerchantDenominations',
  z.object({
    type: z.enum(['fixed', 'min-max']),
    denominations: z.array(z.string()),
    currency: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
);

const Merchant = registry.register(
  'Merchant',
  z.object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().optional(),
    cardImageUrl: z.string().optional(),
    savingsPercentage: z.number().optional(),
    denominations: MerchantDenominations.optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    terms: z.string().optional(),
    enabled: z.boolean(),
    locationCount: z.number().optional(),
  }),
);

const Pagination = registry.register(
  'Pagination',
  z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  }),
);

const MerchantListResponse = registry.register(
  'MerchantListResponse',
  z.object({
    merchants: z.array(Merchant),
    pagination: Pagination,
  }),
);

const MerchantDetailResponse = registry.register(
  'MerchantDetailResponse',
  z.object({ merchant: Merchant }),
);

const MerchantAllResponse = registry.register(
  'MerchantAllResponse',
  z.object({
    merchants: z.array(Merchant),
    total: z.number(),
  }),
);

// ─── Orders ─────────────────────────────────────────────────────────────────

const CreateOrderBody = registry.register(
  'CreateOrderBody',
  z.object({
    merchantId: z.string().min(1).max(128),
    amount: z.number().min(0.01).max(10_000).multipleOf(0.01).openapi({
      description:
        '2-decimal precision, in merchant currency. Accepted range is 0.01 – 10_000, matching the runtime CreateOrderBody schema in apps/backend/src/orders/handler.ts.',
    }),
  }),
);

const CreateOrderResponse = registry.register(
  'CreateOrderResponse',
  z.object({
    orderId: z.string(),
    paymentUri: z.string().openapi({
      description: 'Stellar payment URI, e.g. web+stellar:pay?destination=...&amount=...&memo=...',
    }),
    paymentAddress: z.string(),
    xlmAmount: z.string(),
    memo: z.string(),
    expiresAt: z.number().openapi({
      description: 'Unix timestamp (seconds) — server-authoritative payment window close.',
    }),
  }),
);

const OrderStatus = z.enum(['pending', 'completed', 'failed', 'expired']);

const Order = registry.register(
  'Order',
  z.object({
    id: z.string(),
    merchantId: z.string(),
    merchantName: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: OrderStatus,
    xlmAmount: z.string(),
    percentDiscount: z.string().optional(),
    redeemType: z.enum(['url', 'barcode']).optional(),
    giftCardCode: z.string().optional(),
    giftCardPin: z.string().optional(),
    redeemUrl: z.string().optional(),
    redeemChallengeCode: z.string().optional(),
    // CTX sometimes returns helper scripts for automating redemption
    // inside the WebView (inject challenge, scrape result). Present in
    // the handler response and in the shared `Order` type, previously
    // missing from the OpenAPI schema — a generated client would have
    // stripped them as unknown fields.
    redeemScripts: z
      .object({
        injectChallenge: z.string().optional(),
        scrapeResult: z.string().optional(),
      })
      .optional(),
    createdAt: z.string(),
  }),
);

const OrderListResponse = registry.register(
  'OrderListResponse',
  z.object({ orders: z.array(Order), pagination: Pagination }),
);

// The GET /api/orders/{id} handler wraps its result as `{ order }` — see
// `c.json({ order })` in `apps/backend/src/orders/handler.ts`. The web
// client (`services/orders.ts`) also consumes the wrapped shape. Register
// the wrapper explicitly so generated OpenAPI clients parse the same
// envelope instead of trying to unmarshal the raw Order type.
const OrderDetailResponse = registry.register('OrderDetailResponse', z.object({ order: Order }));

// ─── Users ──────────────────────────────────────────────────────────────────

const UserMeView = registry.register(
  'UserMeView',
  z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    isAdmin: z.boolean(),
    homeCurrency: z.enum(['USD', 'GBP', 'EUR']).openapi({
      description:
        'Fiat the account is denominated in (ADR 015). Drives order pricing + the LOOP-asset cashback payout.',
    }),
    stellarAddress: z.string().nullable().openapi({
      description:
        "User's linked Stellar wallet for on-chain payouts. Null = unlinked; cashback accrues off-chain only.",
    }),
    homeCurrencyBalanceMinor: z.string().openapi({
      description:
        'Off-chain cashback balance in `homeCurrency` minor units (pence / cents), as a bigint-string so JSON round-trips don\'t truncate precision. `"0"` when the user has no ledger row yet (first-order users, pre-cashback).',
    }),
  }),
);

const SetHomeCurrencyBody = registry.register(
  'SetHomeCurrencyBody',
  z.object({
    currency: z.enum(['USD', 'GBP', 'EUR']),
  }),
);

const SetStellarAddressBody = registry.register(
  'SetStellarAddressBody',
  z.object({
    address: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/)
      .nullable()
      .openapi({
        description: 'Stellar public key (G…). Passing null unlinks the current wallet.',
      }),
  }),
);

const CashbackHistoryEntry = registry.register(
  'CashbackHistoryEntry',
  z.object({
    id: z.string().uuid(),
    type: z
      .enum(['cashback', 'interest', 'spend', 'withdrawal', 'refund', 'adjustment'])
      .openapi({ description: 'Ledger event kind — see `credit_transactions.type` (ADR 009).' }),
    amountMinor: z.string().openapi({
      description:
        'Pence / cents in `currency`, as a bigint-string. Positive for cashback / interest / refund, negative for spend / withdrawal, either for adjustment.',
    }),
    currency: z.string().length(3),
    referenceType: z.string().nullable().openapi({
      description: "Source tag, e.g. `'order'`. Null when support-adjusted directly.",
    }),
    referenceId: z.string().nullable().openapi({
      description: 'Matching reference id (e.g. order UUID).',
    }),
    createdAt: z.string().datetime(),
  }),
);

const CashbackHistoryResponse = registry.register(
  'CashbackHistoryResponse',
  z.object({ entries: z.array(CashbackHistoryEntry) }),
);

// ─── Users — credit balances (ADR 009 / 015) ────────────────────────────────

const UserCreditRow = registry.register(
  'UserCreditRow',
  z.object({
    currency: z.string().length(3),
    balanceMinor: z.string().openapi({
      description: 'bigint-as-string. Minor units (pence / cents).',
    }),
    updatedAt: z.string().datetime(),
  }),
);

const UserCreditsResponse = registry.register(
  'UserCreditsResponse',
  z.object({ credits: z.array(UserCreditRow) }),
);

// ─── Admin (ADR 015 — treasury + payouts) ───────────────────────────────────

const LoopAssetCode = z
  .enum(['USDLOOP', 'GBPLOOP', 'EURLOOP'])
  .openapi({ description: 'LOOP-branded fiat stablecoin code (ADR 015).' });

const PayoutState = z
  .enum(['pending', 'submitted', 'confirmed', 'failed'])
  .openapi({ description: 'pending_payouts row lifecycle (ADR 015/016).' });

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
    operatorPool: z.object({
      size: z.number().int(),
      operators: z.array(OperatorHealthEntry),
    }),
  }),
);

const AdminPayoutView = registry.register(
  'AdminPayoutView',
  z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    orderId: z.string().uuid(),
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
  }),
);

const AdminSupplierSpendResponse = registry.register(
  'AdminSupplierSpendResponse',
  z.object({
    since: z.string().datetime(),
    rows: z.array(AdminSupplierSpendRow),
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

const CashbackPctString = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,2})?$/)
  .openapi({
    description:
      'Percentage in the range [0, 100] with ≤2 decimal places, serialised as a string to match the Postgres numeric(5,2) wire shape (e.g. `"80.00"`).',
  });

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

const AdminCashbackConfigDetailResponse = registry.register(
  'AdminCashbackConfigDetailResponse',
  z.object({ config: AdminCashbackConfig }),
);

const UpsertCashbackConfigBody = registry.register(
  'UpsertCashbackConfigBody',
  z
    .object({
      wholesalePct: z.coerce.number().min(0).max(100),
      userCashbackPct: z.coerce.number().min(0).max(100),
      loopMarginPct: z.coerce.number().min(0).max(100),
      active: z.boolean().optional(),
    })
    .openapi({
      description:
        'The three split percentages are coerced from number-or-numeric-string and must sum to ≤100. `active` defaults to true on initial insert.',
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

// ─── Clustering ─────────────────────────────────────────────────────────────

const ClusterBounds = z.object({
  west: z.number().min(-180).max(180),
  south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
});

const GeoJsonFeature = z.object({}).openapi({ type: 'object', description: 'GeoJSON feature.' });

const ClusterResponse = registry.register(
  'ClusterResponse',
  z.object({
    locationPoints: z.array(GeoJsonFeature),
    clusterPoints: z.array(GeoJsonFeature),
    total: z.number(),
    zoom: z.number(),
    loadedAt: z.number(),
    bounds: ClusterBounds,
  }),
);

// ─── Health / metrics ───────────────────────────────────────────────────────

const HealthResponse = registry.register(
  'HealthResponse',
  z.object({
    status: z.enum(['healthy', 'degraded']),
    locationCount: z.number(),
    locationsLoading: z.boolean(),
    merchantCount: z.number(),
    merchantsLoadedAt: z.string().openapi({ format: 'date-time' }),
    locationsLoadedAt: z.string().openapi({ format: 'date-time' }),
    merchantsStale: z.boolean(),
    locationsStale: z.boolean(),
    upstreamReachable: z.boolean(),
  }),
);

// ─── Route registration ─────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Liveness + upstream reachability probe.',
  tags: ['Meta'],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: HealthResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/metrics',
  summary: 'Prometheus-format metrics (counters, gauges).',
  tags: ['Meta'],
  responses: {
    200: {
      description: 'Prometheus text format',
      content: { 'text/plain; version=0.0.4': { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/request-otp',
  summary: 'Request a one-time password be emailed to the given address.',
  description:
    'Email-enumeration defense: returns 200 with "Verification code sent" even when upstream responds with 4xx (e.g. "no such user"). Clients cannot distinguish "email was accepted" from "email was rejected as unknown" by the response status. Only 5xx upstream errors surface as 502 so legitimate users are not left waiting on real outages.',
  tags: ['Auth'],
  request: { body: { content: { 'application/json': { schema: RequestOtpBody } } } },
  responses: {
    200: {
      description:
        'OTP queued upstream — OR, by design, email rejected upstream with a 4xx (see description for enumeration-defense rationale).',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (5/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open — upstream unavailable',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/verify-otp',
  summary: 'Exchange an OTP for access and refresh tokens.',
  tags: ['Auth'],
  request: { body: { content: { 'application/json': { schema: VerifyOtpBody } } } },
  responses: {
    200: { description: 'Tokens', content: { 'application/json': { schema: VerifyOtpResponse } } },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'OTP invalid or expired',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream returned an unexpected shape or non-auth error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open — upstream unavailable',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/refresh',
  summary: 'Exchange a refresh token for a new access token (may rotate refresh token).',
  tags: ['Auth'],
  request: { body: { content: { 'application/json': { schema: RefreshBody } } } },
  responses: {
    200: { description: 'Refreshed', content: { 'application/json': { schema: RefreshResponse } } },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Refresh token invalid',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (30/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream transient error — refresh token may still be valid',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open — upstream unavailable',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/auth/session',
  summary: 'Logout — revokes refresh token upstream and clears local session.',
  tags: ['Auth'],
  request: { body: { content: { 'application/json': { schema: LogoutBody } } } },
  responses: {
    200: {
      description: 'Logged out (always succeeds even if upstream revoke fails)',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
    429: {
      description: 'Rate limit exceeded (20/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants',
  summary: 'Paginated merchant list with optional name filter.',
  tags: ['Merchants'],
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      q: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Merchant page',
      content: { 'application/json': { schema: MerchantListResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants/all',
  summary:
    'Full merchant catalog in a single response. Serves UI surfaces that need every merchant (audit A-002).',
  tags: ['Merchants'],
  responses: {
    200: {
      description: 'Complete merchant catalog',
      content: { 'application/json': { schema: MerchantAllResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants/by-slug/{slug}',
  summary: 'Fetch a merchant by URL-safe slug.',
  tags: ['Merchants'],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: {
      description: 'Merchant',
      content: { 'application/json': { schema: MerchantDetailResponse } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants/{id}',
  summary: 'Fetch a merchant by id.',
  tags: ['Merchants'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Merchant',
      content: { 'application/json': { schema: MerchantDetailResponse } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants/cashback-rates',
  summary: 'Bulk cashback-rate map for the merchant catalog (ADR 011 / 015).',
  description:
    'Returns a `{ merchantId → userCashbackPct }` map of every merchant with an active cashback config. Lets catalog / list / map views render "X% cashback" badges per card without N+1-ing the per-merchant endpoint. Merchants without an active config are omitted — clients should treat missing keys as "no cashback" and hide the badge. Values are `numeric(5,2)` strings (e.g. `"2.50"`). 5-minute public cache matches the merchant-catalog endpoints.',
  tags: ['Merchants'],
  responses: {
    200: {
      description: 'Bulk rates map',
      content: {
        'application/json': {
          schema: z.object({
            rates: z.record(z.string(), CashbackPctString).openapi({
              description:
                'Object keyed by merchantId; present only for merchants with active configs.',
            }),
          }),
        },
      },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/merchants/{merchantId}/cashback-rate',
  summary: 'Cashback-rate preview for the gift-card detail page (ADR 011 / 015).',
  description:
    "Public surface — no auth. Returns the merchant's active `user_cashback_pct` as a bigint-shaped `numeric(5,2)` string, or `null` when the merchant has no cashback config (or it's inactive). Clients should hide the cashback badge on `null`. 5-minute public cache matches the merchant-catalog endpoints.",
  tags: ['Merchants'],
  request: { params: z.object({ merchantId: z.string() }) },
  responses: {
    200: {
      description: 'Cashback-rate preview',
      content: {
        'application/json': {
          schema: z.object({
            merchantId: z.string(),
            userCashbackPct: z
              .string()
              .regex(/^\d{1,3}(?:\.\d{1,2})?$/)
              .nullable()
              .openapi({
                description:
                  'Percentage in [0, 100] with ≤2 decimals (e.g. `"2.50"`), or null when no active config exists.',
              }),
          }),
        },
      },
    },
    400: {
      description: 'Invalid merchant id (must match `[\\w-]+`).',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Merchant not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/orders',
  summary: 'Create a gift card order (authenticated).',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateOrderBody } } } },
  responses: {
    201: {
      description: 'Order created',
      content: { 'application/json': { schema: CreateOrderResponse } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Unknown merchant',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream error from CTX',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/orders',
  summary: 'List orders for the authenticated user.',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: {
    // Only these three are forwarded to upstream; unknown params are
    // stripped — see `ALLOWED_LIST_QUERY_PARAMS` in `orders/handler.ts`.
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      perPage: z.coerce.number().int().min(1).max(100).optional(),
      status: z.string().max(32).optional(),
    }),
  },
  responses: {
    200: { description: 'Orders', content: { 'application/json': { schema: OrderListResponse } } },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream error from CTX',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/orders/{id}',
  summary: 'Fetch a single order by id.',
  tags: ['Orders'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Order', content: { 'application/json': { schema: OrderDetailResponse } } },
    400: {
      description: 'Invalid order id',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorResponse } } },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream error from CTX',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Circuit breaker open',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ─── User profile (ADR 015) ──────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/api/users/me',
  summary: 'Current user profile (ADR 015).',
  description:
    'Returns id / email / admin flag / home currency / linked Stellar address. Home currency drives order denomination + cashback-asset selection; the linked address is the destination for on-chain LOOP-asset payouts (null = off-chain accrual only).',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: UserMeView } } },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/users/me/home-currency',
  summary: "Set the user's home currency (ADR 015).",
  description:
    'Onboarding-time picker. Writes `users.home_currency` when the user has zero orders. After the first order lands, the ledger is pinned to that currency and the endpoint returns 409 `HOME_CURRENCY_LOCKED` — support has a separate path to correct it.',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: SetHomeCurrencyBody } } } },
  responses: {
    200: {
      description: 'Updated profile',
      content: { 'application/json': { schema: UserMeView } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User row disappeared between resolve + update',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    409: {
      description: 'HOME_CURRENCY_LOCKED — user has already placed orders',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/users/me/stellar-address',
  summary: "Link or unlink the user's Stellar wallet (ADR 015).",
  description:
    'Pass a Stellar public key (G…) to opt into on-chain cashback payouts; pass `null` to unlink. Relinking is allowed at any time — the column is a routing hint, not a ledger-pinned value.',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: SetStellarAddressBody } } } },
  responses: {
    200: {
      description: 'Updated profile',
      content: { 'application/json': { schema: UserMeView } },
    },
    400: {
      description: 'Malformed Stellar pubkey',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User row disappeared between resolve + update',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/me/cashback-history',
  summary: 'Recent credit-ledger events for the caller (ADR 009 / 015).',
  description:
    "Paginated cashback / interest / spend / withdrawal / refund / adjustment rows for the authenticated user. Page older rows with `?before=<iso-8601>`; cap the page size with `?limit=` (default 20, hard-capped at 100). Always scoped to the caller — admins use the separate `/api/admin/*` surfaces to inspect other users' ledgers.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
      before: z
        .string()
        .datetime()
        .optional()
        .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
    }),
  },
  responses: {
    200: {
      description: 'Ledger entries, newest first',
      content: { 'application/json': { schema: CashbackHistoryResponse } },
    },
    400: {
      description: 'Invalid before timestamp',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/me/credits',
  summary: 'Caller per-currency credit balance (ADR 009 / 015).',
  description:
    'Multi-currency complement to `/api/users/me`, which exposes only the home-currency scalar. Returns one row per non-zero `user_credits` currency — useful after a home-currency flip leaves a residual balance, or when support credits a user in a non-home currency. Empty `credits` when the user has never earned / has fully redeemed.',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Per-currency balances',
      content: { 'application/json': { schema: UserCreditsResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ─── Users — pending-payouts view (ADR 015 / 016) ──────────────────────────
//
// Registered down here (outside the Users schema block) so the `PayoutState`
// enum from the Admin section is available. The shape is a trimmed subset of
// `AdminPayoutView` — no `userId`, `toAddress`, or `memoText` because the
// user already knows they're looking at their own account, and surfacing the
// destination wallet / memo would expose internals without adding value.

const UserPendingPayoutView = registry.register(
  'UserPendingPayoutView',
  z.object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    assetCode: z
      .string()
      .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
    assetIssuer: z.string().openapi({ description: 'Stellar issuer account for this asset.' }),
    amountStroops: z
      .string()
      .openapi({ description: 'Payout amount in stroops (7 decimals). BigInt as string.' }),
    state: PayoutState,
    txHash: z.string().nullable().openapi({
      description: 'Confirmed Stellar tx hash — null until the payout is confirmed on-chain.',
    }),
    attempts: z.number().int(),
    createdAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    confirmedAt: z.string().datetime().nullable(),
    failedAt: z.string().datetime().nullable(),
  }),
);

const UserPendingPayoutsResponse = registry.register(
  'UserPendingPayoutsResponse',
  z.object({ payouts: z.array(UserPendingPayoutView) }),
);

registry.registerPath({
  method: 'get',
  path: '/api/users/me/pending-payouts',
  summary: "Caller's on-chain payout rows (ADR 015 / 016).",
  description:
    "Returns the user's own `pending_payouts` rows — one row per outbound LOOP-asset payment tracked through its lifecycle (`pending → submitted → confirmed | failed`). Mirrors the admin endpoint's query shape (`?state=`, `?before=`, `?limit=`) but is scoped to the authenticated caller by `userId` — no admin-privileged cross-user access. Clients poll this from the wallet / cashback settings views while a payout is in flight.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      state: PayoutState.optional().openapi({
        description: 'Filter to a single lifecycle state. Omitted → all states.',
      }),
      before: z
        .string()
        .datetime()
        .optional()
        .openapi({ description: 'ISO-8601 timestamp — return rows strictly older than this.' }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .openapi({ description: 'Page size. Default 20, hard-capped at 100.' }),
    }),
  },
  responses: {
    200: {
      description: 'Payout rows, newest first',
      content: { 'application/json': { schema: UserPendingPayoutsResponse } },
    },
    400: {
      description: 'Invalid state or before',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/me/pending-payouts/{id}',
  summary: 'Caller-scoped single payout detail (ADR 015 / 016).',
  description:
    "Permalink for one of the caller's `pending_payouts` rows. The settings/cashback page deep-links each row so the user can share the URL with support when asking about a stuck payout. Cross-user access returns 404 (not 403) so payout ids aren't enumerable.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Payout row',
      content: { 'application/json': { schema: UserPendingPayoutView } },
    },
    400: {
      description: 'Missing or malformed id',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Payout not found (or owned by a different user)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
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
      before: z
        .string()
        .datetime()
        .optional()
        .openapi({ description: 'ISO-8601 — return rows strictly older than this createdAt.' }),
      limit: z.coerce.number().int().min(1).max(100).optional().openapi({
        description: 'Page size. Default 20, hard-capped at 100.',
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Payout not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the row',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/payouts/{id}/retry',
  summary: 'Flip a failed payout back to pending (ADR 015 / 016).',
  description:
    'Admin-only manual retry: resets a `failed` pending_payouts row to `pending` so the submit worker picks it up on the next tick. 404 when the id matches nothing or the row is in a non-failed state — the admin UI should refresh the list. The worker enforces memo-idempotency on re-submit (ADR 016) so double-retry never double-pays.',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Updated payout row',
      content: { 'application/json': { schema: AdminPayoutView } },
    },
    400: {
      description: 'Missing or malformed id',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Payout not found or not in failed state',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (20/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resetting the row',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Order not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the row',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'No payout row for this order',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the row',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the table',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the row',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the ledger',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the ledger',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error building the export',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error building the export',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading the table',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/merchant-cashback-configs/{merchantId}',
  summary: 'Upsert a merchant cashback-split config (ADR 011).',
  description:
    'INSERT on first touch, UPDATE otherwise. Either way a Postgres trigger appends the pre-edit values to `merchant_cashback_config_history` so every change is auditable by `admin_user_id` + timestamp. The response echoes the latest row — the frontend uses it to refresh the list without a second round-trip.',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ merchantId: z.string() }),
    body: { content: { 'application/json': { schema: UpsertCashbackConfigBody } } },
  },
  responses: {
    200: {
      description: 'Updated row',
      content: { 'application/json': { schema: AdminCashbackConfigDetailResponse } },
    },
    400: {
      description: 'Invalid body — percentages out of range, sum > 100, or missing merchantId',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/clusters',
  summary: 'Clustered merchant locations for the given viewport.',
  tags: ['Clustering'],
  request: {
    query: z.object({
      west: z.coerce.number().min(-180).max(180),
      south: z.coerce.number().min(-90).max(90),
      east: z.coerce.number().min(-180).max(180),
      north: z.coerce.number().min(-90).max(90),
      zoom: z.coerce.number().int().min(0).max(28),
    }),
  },
  responses: {
    200: {
      description: 'Clusters (protobuf preferred via Accept header)',
      content: {
        'application/json': { schema: ClusterResponse },
        'application/x-protobuf': { schema: z.string().openapi({ format: 'binary' }) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/image',
  summary: 'Fetch, resize, and re-encode a remote image (SSRF-validated).',
  tags: ['Images'],
  request: {
    query: z.object({
      url: z.string().url(),
      width: z.coerce.number().int().min(1).max(2000).optional(),
      height: z.coerce.number().int().min(1).max(2000).optional(),
      quality: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Image bytes',
      content: {
        'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
        'image/webp': { schema: z.string().openapi({ format: 'binary' }) },
      },
    },
    400: {
      description: 'Validation / SSRF rejection',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    413: {
      description: 'Image exceeds 10MB limit',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (300/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream image error',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ─── Spec generator ─────────────────────────────────────────────────────────

// Register the bearer auth scheme on the registry so the generator emits it
// under components.securitySchemes.
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Upstream CTX access token. Obtain via POST /api/auth/verify-otp and refresh via POST /api/auth/refresh.',
});

const generator = new OpenApiGeneratorV31(registry.definitions);

export function generateOpenApiSpec(): ReturnType<typeof generator.generateDocument> {
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Loop API',
      version: '1.0.0',
      description:
        'Loop backend API. Proxies the upstream CTX gift-card provider and serves cached merchant/location data. Auth tokens are upstream tokens passed through — this API does not issue JWTs of its own. See docs/architecture.md for full context.',
      contact: { name: 'Loop', url: 'https://loopfinance.io' },
    },
    servers: [
      { url: 'https://api.loopfinance.io', description: 'Production' },
      { url: 'http://localhost:8080', description: 'Local dev' },
    ],
    tags: [
      { name: 'Meta', description: 'Liveness, metrics, and misc.' },
      { name: 'Auth', description: 'OTP request / verify / refresh (proxied to upstream).' },
      { name: 'Merchants', description: 'Merchant catalog, cached from upstream.' },
      { name: 'Orders', description: 'Gift card orders.' },
      {
        name: 'Users',
        description:
          'User profile: home currency + linked Stellar wallet (ADR 015). Called during onboarding and from the wallet-settings screen.',
      },
      {
        name: 'Admin',
        description:
          'Admin-only surfaces: treasury snapshot + pending-payouts backlog (ADR 015), merchant cashback-split config CRUD + history (ADR 011). All routes require both `requireAuth` and `requireAdmin`.',
      },
      { name: 'Clustering', description: 'Map cluster / location points.' },
      { name: 'Images', description: 'Image proxy + resize.' },
    ],
  });
}
