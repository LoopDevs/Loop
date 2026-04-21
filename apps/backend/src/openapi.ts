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
      { name: 'Clustering', description: 'Map cluster / location points.' },
      { name: 'Images', description: 'Image proxy + resize.' },
    ],
  });
}
