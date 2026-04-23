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
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';

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
    address: z.string().regex(STELLAR_PUBKEY_REGEX).nullable().openapi({
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

// ─── Public — landing-page aggregates (ADR 009 / 015 / 020) ────────────────

const PerCurrencyCashback = registry.register(
  'PerCurrencyCashback',
  z.object({
    currency: z.string().length(3),
    amountMinor: z.string().openapi({
      description: 'bigint-as-string. Minor units (pence / cents).',
    }),
  }),
);

const PublicCashbackStats = registry.register(
  'PublicCashbackStats',
  z.object({
    totalUsersWithCashback: z.number().int().min(0),
    totalCashbackByCurrency: z.array(PerCurrencyCashback),
    fulfilledOrders: z.number().int().min(0),
    asOf: z.string().datetime(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/cashback-stats',
  summary: 'Fleet-wide cashback aggregates for the landing page.',
  description:
    'Unauthenticated, CDN-friendly. Returns the user count with any earned cashback, per-currency cashback totals, and fulfilled order count. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path if the backend is serving a last-known-good snapshot or zeros. Never 500 — a DB outage degrades to stale/zero rather than propagating to unauthenticated visitors.',
  tags: ['Public'],
  responses: {
    200: {
      description: 'Cashback stats snapshot',
      content: { 'application/json': { schema: PublicCashbackStats } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ─── Public — top cashback merchants (ADR 011 / 020) ───────────────────────

const TopCashbackMerchant = registry.register(
  'TopCashbackMerchant',
  z.object({
    id: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    userCashbackPct: z.string().openapi({
      description: 'numeric(5,2) as string, e.g. "15.00".',
    }),
  }),
);

const PublicTopCashbackMerchantsResponse = registry.register(
  'PublicTopCashbackMerchantsResponse',
  z.object({
    merchants: z.array(TopCashbackMerchant),
    asOf: z.string().datetime(),
  }),
);

const PublicLoopAsset = registry.register(
  'PublicLoopAsset',
  z.object({
    code: z.enum(['USDLOOP', 'GBPLOOP', 'EURLOOP']).openapi({
      description: 'LOOP-branded fiat stablecoin code (ADR 015).',
    }),
    issuer: z.string().openapi({
      description: 'Stellar G-account that mints the asset. Pinned by env at boot.',
    }),
  }),
);

const PublicLoopAssetsResponse = registry.register(
  'PublicLoopAssetsResponse',
  z.object({ assets: z.array(PublicLoopAsset) }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/loop-assets',
  summary: 'Configured LOOP-asset (code, issuer) pairs (ADR 015 / 020).',
  description:
    'Public transparency surface. Lists the LOOP-branded Stellar assets Loop pays cashback in, with their issuer public keys, so third-party wallets + users adding trustlines can verify the asset list without guessing from on-chain traffic. Only issuer-configured pairs appear — publishing an unconfigured code would risk users opening a trustline to a spoofed issuer. `Cache-Control: public, max-age=300` on the happy path, `max-age=60` on the empty-list fallback. Never 500.',
  tags: ['Public'],
  responses: {
    200: {
      description: 'Configured LOOP-asset pairs (possibly empty).',
      content: { 'application/json': { schema: PublicLoopAssetsResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const PublicFlywheelStats = registry.register(
  'PublicFlywheelStats',
  z.object({
    windowDays: z.number().int().openapi({ description: 'Fixed 30-day window.' }),
    fulfilledOrders: z.number().int(),
    recycledOrders: z.number().int(),
    pctRecycled: z.string().openapi({
      description:
        'One-decimal percentage string, e.g. `"12.3"`. `"0.0"` when the denominator is zero.',
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/flywheel-stats',
  summary: 'Fleet-wide cashback-flywheel scalar (ADR 015 / 020).',
  description:
    'Unauthenticated marketing surface. Scalar `{ fulfilledOrders, recycledOrders, pctRecycled }` over the last 30 days — the complement to `/api/public/cashback-stats` (emission) showing the recycle side of the story. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path. Never 500.',
  tags: ['Public'],
  responses: {
    200: {
      description: '30-day flywheel scalar.',
      content: { 'application/json': { schema: PublicFlywheelStats } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/public/top-cashback-merchants',
  summary: 'Top-N merchants by active cashback rate (ADR 011 / 020).',
  description:
    'Unauthenticated, CDN-friendly. Landing-page "best cashback" band. `?limit=` clamped 1..50 (default 10). Merchants whose row has been evicted from the in-memory catalog (ADR 021 Rule B) are dropped from the response so the list never links to about-to-vanish merchants. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path. Never 500.',
  tags: ['Public'],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Top merchants by user_cashback_pct, descending',
      content: { 'application/json': { schema: PublicTopCashbackMerchantsResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const PublicMerchantDetail = registry.register(
  'PublicMerchantDetail',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string().openapi({
      description: 'Marketing slug — matches merchantSlug(name) on the web side.',
    }),
    logoUrl: z.string().nullable(),
    userCashbackPct: z.string().nullable().openapi({
      description:
        'numeric(5,2) as string, e.g. "5.50". null when no active config — the "coming soon" SEO state, distinct from "merchant not found" which returns 404.',
    }),
    asOf: z.string().datetime(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/merchants/{id}',
  summary: 'Per-merchant SEO detail (ADR 011 / 020).',
  description:
    'Unauthenticated single-merchant view for the /cashback/:slug landing page. Accepts merchant id OR slug as the path parameter. Narrow PII-free shape (no wholesale / margin — only user-facing cashback pct). Never 500: DB trouble → per-merchant last-known-good cache; first-miss → catalog row with null pct. 404 only for unknown id/slug (evicted merchants / typo URLs). `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path.',
  tags: ['Public'],
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Merchant id or slug.' }),
    }),
  },
  responses: {
    200: {
      description: 'Merchant catalog row + current cashback pct (or null)',
      content: { 'application/json': { schema: PublicMerchantDetail } },
    },
    400: {
      description: 'Malformed merchant id / slug',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Unknown merchant id / slug',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const PublicCashbackPreview = registry.register(
  'PublicCashbackPreview',
  z.object({
    merchantId: z.string(),
    merchantName: z.string(),
    orderAmountMinor: z.string().openapi({
      description: 'Echo of the caller-supplied amountMinor, bigint-as-string.',
    }),
    cashbackPct: z.string().nullable().openapi({
      description: 'numeric(5,2) as string, null when no active config.',
    }),
    cashbackMinor: z.string().openapi({
      description: 'Computed cashback amount (floor). bigint-as-string. "0" when no config.',
    }),
    currency: z.string().length(3),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/public/cashback-preview',
  summary: 'Pre-signup "calculate your cashback" preview (ADR 011 / 015 / 020).',
  description:
    "Unauthenticated. Returns the cashback a would-be user would earn on an `amountMinor` order at `merchantId`. Matches the floor-rounded math used by `orders/cashback-split.ts` so the preview never promises more than the order-insert path will actually award. Missing config → 200 with `cashbackPct: null, cashbackMinor: '0'` (the 'coming soon' shape). Unknown merchant id/slug → 404. Never 500: a DB failure falls back to the soft-empty shape with `Cache-Control: max-age=60`.",
  tags: ['Public'],
  request: {
    query: z.object({
      merchantId: z.string().openapi({ description: 'Merchant id or slug.' }),
      amountMinor: z.string().openapi({
        description: 'Amount in merchant-currency minor units, as a non-negative integer string.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Cashback preview (may carry null pct for "coming soon")',
      content: { 'application/json': { schema: PublicCashbackPreview } },
    },
    400: {
      description: 'Malformed merchantId or amountMinor, or amount out of range',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Unknown merchant id / slug',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

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

const TreasuryOrderFlow = z.object({
  count: z.string().openapi({
    description: 'Number of fulfilled orders in this charge-currency bucket. BigInt-string count.',
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
      description: 'Horizon-issued circulation for (assetCode, issuer). bigint-as-string stroops.',
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

// ─── Public config (ADR 013 / 014 / 015) ────────────────────────────────────

const LoopAssetConfig = z.object({
  issuer: z.string().nullable().openapi({
    description: 'Stellar issuer account for this LOOP asset, null when unconfigured.',
  }),
  available: z.boolean().openapi({
    description: 'Convenience flag — `issuer !== null`. `true` means on-chain payout is live.',
  }),
});

const AppConfigResponse = registry.register(
  'AppConfigResponse',
  z.object({
    loopAuthNativeEnabled: z.boolean().openapi({
      description: 'ADR 013 — Loop-native auth (OTP + Loop-minted JWTs) is active.',
    }),
    loopOrdersEnabled: z.boolean().openapi({
      description:
        'ADR 010 — Loop-native orders can be placed (auth + workers + deposit address all configured).',
    }),
    loopAssets: z.object({
      USDLOOP: LoopAssetConfig,
      GBPLOOP: LoopAssetConfig,
      EURLOOP: LoopAssetConfig,
    }),
    social: z.object({
      googleClientIdWeb: z.string().nullable(),
      googleClientIdIos: z.string().nullable(),
      googleClientIdAndroid: z.string().nullable(),
      appleServiceId: z.string().nullable(),
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/config',
  summary: 'Public client config — feature flags + social IDs + LOOP-asset availability.',
  description:
    'Unauthenticated. Returned fields are safe to ship in the web / mobile bundle. Clients cache for up to 10 minutes per the Cache-Control response header.',
  tags: ['Config'],
  responses: {
    200: {
      description: 'App config',
      content: { 'application/json': { schema: AppConfigResponse } },
    },
  },
});

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

const StellarTrustlineRow = registry.register(
  'StellarTrustlineRow',
  z.object({
    code: LoopAssetCode,
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (30/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error resolving the user',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Horizon trustline check unavailable',
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
  path: '/api/users/me/cashback-history.csv',
  summary: 'Full credit-ledger CSV export for the caller (ADR 009).',
  description:
    "One-shot CSV dump of the caller's credit-ledger history. Columns: Created (UTC), Type, Amount (minor), Currency, Reference type, Reference ID. Capped at 10 000 rows; the `X-Result-Count` response header reports the actual row count so the client can warn when the cap is hit. Tighter rate limit (6/min) than the JSON sibling because the query is unbounded in size.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description:
        'CSV attachment — Content-Disposition: attachment; filename="loop-cashback-history.csv".',
      content: { 'text/csv': { schema: z.string() } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (6/min per IP)',
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

const UserPendingPayoutsSummaryRow = registry.register(
  'UserPendingPayoutsSummaryRow',
  z.object({
    assetCode: z
      .string()
      .openapi({ description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP.' }),
    state: z.enum(['pending', 'submitted']),
    count: z.number().int().nonnegative(),
    totalStroops: z.string().openapi({
      description: 'Sum of `amount_stroops` in the bucket. BigInt as string.',
    }),
    oldestCreatedAt: z.string().datetime(),
  }),
);

const UserPendingPayoutsSummaryResponse = registry.register(
  'UserPendingPayoutsSummaryResponse',
  z.object({ rows: z.array(UserPendingPayoutsSummaryRow) }),
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
  path: '/api/users/me/pending-payouts/summary',
  summary: "Caller's pending-payouts aggregate (ADR 015 / 016).",
  description:
    "Aggregate view of the caller's in-flight payouts bucketed by `(asset_code, state)`. One round-trip replaces paging the full list when a UI only needs the 'you have $X cashback settling' signal. Excludes `confirmed` rows (they're in the cashback history feed) and `failed` rows (they belong to the admin retry flow, not the user's in-flight view). Empty `rows` when the caller has no in-flight payouts.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'One row per (assetCode, state) bucket',
      content: { 'application/json': { schema: UserPendingPayoutsSummaryResponse } },
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

const UserCashbackSummary = registry.register(
  'UserCashbackSummary',
  z.object({
    currency: z.string().length(3),
    lifetimeMinor: z.string(),
    thisMonthMinor: z.string(),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/users/me/cashback-summary',
  summary: 'Compact lifetime + this-month cashback totals (ADR 009 / 015).',
  description:
    "Two-number headline the home / cashback pages render: `lifetimeMinor` is all-time cashback earned, `thisMonthMinor` resets at 00:00 UTC on the 1st. Both filter to `type='cashback'` in the user's current `home_currency` — no cross-currency sum (rare multi-currency users see only their home-currency earnings; admin ledger has cross-currency detail). `bigint`-minor units as strings.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Cashback summary',
      content: { 'application/json': { schema: UserCashbackSummary } },
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
      description: 'Internal error computing the summary',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const UserCashbackByMerchantRow = registry.register(
  'UserCashbackByMerchantRow',
  z.object({
    merchantId: z.string(),
    cashbackMinor: z.string(),
    orderCount: z.number().int().nonnegative(),
    lastEarnedAt: z.string().datetime(),
  }),
);

const UserCashbackByMerchantResponse = registry.register(
  'UserCashbackByMerchantResponse',
  z.object({
    currency: z.string().length(3),
    since: z.string().datetime(),
    rows: z.array(UserCashbackByMerchantRow),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/users/me/cashback-by-merchant',
  summary: 'Top cashback-earning merchants for the caller (ADR 009 / 015).',
  description:
    "Groups the caller's `credit_transactions` (type='cashback', filtered to `home_currency`) by the source order's `merchant_id`. Each row carries earned cashback (bigint-minor as string), distinct order count, and the most-recent ledger-row timestamp. Default window 180 days; server clamps `?since=` to 366d and `?limit=` to 50. Sorted cashback DESC, ties break on lastEarnedAt DESC. `merchantId` is the catalog slug — clients resolve display name via the merchant catalog rather than paying for another round-trip here.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      since: z.string().datetime().optional().openapi({
        description: 'ISO-8601 lower bound on `created_at`. Defaults to 180d ago; capped at 366d.',
      }),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Top-N rows in the window, ordered by cashback DESC',
      content: { 'application/json': { schema: UserCashbackByMerchantResponse } },
    },
    400: {
      description: 'Invalid `since` (or window over 366d)',
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
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/me/cashback-monthly',
  summary: 'Last 12 months of cashback totals grouped by (month, currency).',
  description:
    "Time-axis aggregate of the caller's cashback ledger. `DATE_TRUNC('month', created_at AT TIME ZONE 'UTC')` → `(month, currency)` with `SUM(amount_minor)` filtered to `type='cashback'`. Fixed 12-month window (current UTC month + previous 11). Oldest-first so the bar chart renders left-to-right without a client reverse. Multi-currency safe — a user who moved regions gets both currency entries per month. `cashbackMinor` is bigint-as-string so fleet-wide sums don't truncate.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Monthly entries, oldest first',
      content: {
        'application/json': {
          schema: z.object({
            entries: z.array(
              z.object({
                month: z.string().regex(/^\d{4}-\d{2}$/),
                currency: z.string().length(3),
                cashbackMinor: z.string(),
              }),
            ),
          }),
        },
      },
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
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/users/me/orders/summary',
  summary: "Compact 5-number summary of the caller's orders (ADR 010 / 015).",
  description:
    "Single query with FILTER-ed COUNT + SUM so the /orders page header renders without hitting the list endpoint. `pendingCount` groups `pending_payment` + `paid` + `procuring` — all 'in flight' from the user's perspective. `failedCount` groups `failed` + `expired`. `totalSpentMinor` is `SUM(charge_minor)` over `state = 'fulfilled'` only so pending / failed orders don't inflate lifetime spend. Home-currency locked — cross-currency detail stays admin-only.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '5-number summary',
      content: {
        'application/json': {
          schema: z.object({
            currency: z.string().length(3),
            totalOrders: z.number().int().min(0),
            fulfilledCount: z.number().int().min(0),
            pendingCount: z.number().int().min(0),
            failedCount: z.number().int().min(0),
            totalSpentMinor: z.string(),
          }),
        },
      },
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
      description: 'Internal error computing the summary',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// User-facing flywheel + rail-mix pivot endpoints (ADR 015 / 022).
// These are the self-view counterparts to the admin per-user endpoints
// — same shapes, keyed on auth context instead of path param.

const UserFlywheelStats = registry.register(
  'UserFlywheelStats',
  z.object({
    currency: z.string().length(3).openapi({
      description:
        "Caller's home_currency — both numerator and denominator scoped to it so the ratio shares a denomination.",
    }),
    recycledOrderCount: z.number().int(),
    recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    totalFulfilledCount: z.number().int(),
    totalFulfilledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/users/me/flywheel-stats',
  summary: 'Caller-scoped recycled-vs-total scalar (ADR 015).',
  description:
    "Powers the FlywheelChip on /orders and /settings/cashback. Answers the user's question: 'how much of my spend came back to me as cashback I then spent again?'. Home-currency-locked. Zero-recycled users get zeroed fields (not 404) — the chip self-hides on zero via client-side check.",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Caller recycled-vs-total flywheel scalar',
      content: { 'application/json': { schema: UserFlywheelStats } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

const UserPaymentMethodShareResponseUserSelf = registry.register(
  'UserPaymentMethodShareResponseSelf',
  z.object({
    currency: z.string().length(3),
    state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
    totalOrders: z.number().int(),
    byMethod: z.object({
      xlm: z.object({
        orderCount: z.number().int(),
        chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      }),
      usdc: z.object({
        orderCount: z.number().int(),
        chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      }),
      credit: z.object({
        orderCount: z.number().int(),
        chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      }),
      loop_asset: z.object({
        orderCount: z.number().int(),
        chargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      }),
    }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/users/me/payment-method-share',
  summary: "Caller's own rail mix (ADR 010/015).",
  description:
    'User-facing self-view of the payment-method-share quartet (fleet / per-merchant / per-user admin / self). Powers the RailMixCard on /settings/cashback. Home-currency-locked. A 0% LOOP-asset share is the clearest nudge to pick LOOP at next checkout so cashback compounds.',
  tags: ['Users'],
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
      description: "Caller's own rail mix",
      content: {
        'application/json': { schema: UserPaymentMethodShareResponseUserSelf },
      },
    },
    400: {
      description: 'Invalid ?state',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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

registry.registerPath({
  method: 'get',
  path: '/api/users/me/orders/{orderId}/payout',
  summary: 'Per-order cashback settlement drill (ADR 015 / 016).',
  description:
    "For one of the caller's own orders, return the single pending-payout row tied to it. Mirror of the admin `/api/admin/orders/{orderId}/payout` but ownership-scoped: (orderId, userId) predicate guarantees cross-user access returns 404 (not 403), so order ids aren't enumerable. Powers the per-order settlement card on `/orders/:id` — users see Stellar-side state (pending / submitted / confirmed / failed) next to the gift-card redemption. Null result when the order has no payout row yet (pre-cashback, credit-only ledger, or order doesn't belong to the caller).",
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ orderId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Payout row for the order',
      content: { 'application/json': { schema: UserPendingPayoutView } },
    },
    400: {
      description: 'Missing or malformed orderId',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Missing or invalid bearer',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: "No payout row for this order (or order doesn't belong to caller)",
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
          }),
        },
      },
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
      description: 'Internal error computing the ranking',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error reading the audit tail',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error computing the breakdown',
      content: { 'application/json': { schema: ErrorResponse } },
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
      since: z
        .string()
        .datetime()
        .optional()
        .openapi({ description: 'ISO-8601 — lower bound on `confirmedAt`. Defaults to 24h ago.' }),
    }),
  },
  responses: {
    200: {
      description: 'Per-asset rows plus fleet-wide aggregate',
      content: { 'application/json': { schema: SettlementLagResponse } },
    },
    400: {
      description: 'Malformed `since` or window > 366d',
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
      description: 'Internal error reading activity',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error computing the share',
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
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error loading activity',
      content: { 'application/json': { schema: ErrorResponse } },
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
    409: {
      description: 'Issuer env not configured for this asset',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (30/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error reading ledger liability',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    503: {
      description: 'Horizon circulation read failed',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'No user with that email',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (60/min per IP)',
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
      description: 'Internal error computing the leaderboard',
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
      description: 'Internal error computing the aggregate',
      content: { 'application/json': { schema: ErrorResponse } },
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
    409: {
      description: 'Debit would drive the balance below zero (INSUFFICIENT_BALANCE)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (20/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'Internal error applying the adjustment',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (2/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: {
      description: 'Upstream CTX catalog fetch failed — cached snapshot retained',
      content: { 'application/json': { schema: ErrorResponse } },
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
    409: {
      description: "The channel's webhook env var is unset (WEBHOOK_NOT_CONFIGURED)",
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
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
      description: 'Internal error computing the series',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error computing the series',
      content: { 'application/json': { schema: ErrorResponse } },
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
    userCount: z.string().openapi({
      description: 'Total user_credits rows across all users and currencies. BigInt-string.',
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Not an admin',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (30/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error building the CSV',
      content: { 'application/json': { schema: ErrorResponse } },
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
      description: 'Internal error reading history',
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'DB error',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'DB error',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'DB error',
      content: { 'application/json': { schema: ErrorResponse } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (120/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded (10/min per IP)',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: { description: 'DB error', content: { 'application/json': { schema: ErrorResponse } } },
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
