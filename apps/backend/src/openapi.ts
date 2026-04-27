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
import { ApiErrorCode, type ApiErrorCodeValue } from '@loop/shared';
import { registerAdminOpenApi } from './openapi/admin.js';
import { registerAuthOpenApi } from './openapi/auth.js';
import { registerClustersOpenApi } from './openapi/clusters.js';
import { registerHealthOpenApi } from './openapi/health.js';
import { registerMerchantsOpenApi } from './openapi/merchants.js';
import { registerOrdersOpenApi } from './openapi/orders.js';
import { registerPublicOpenApi } from './openapi/public.js';
import { registerUsersOpenApi } from './openapi/users.js';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ─── Shared components ──────────────────────────────────────────────────────

// A2-1003: derive the OpenAPI `code` enum from the shared `ApiErrorCode`
// const object instead of declaring `z.string()`. The runtime enum is
// the single source of truth — `Object.values(ApiErrorCode)` here means
// adding a code to `packages/shared/src/api.ts` automatically widens the
// schema, and removing one tightens it. Generated clients now see the
// closed set; the web `switch (err.code)` on `ApiErrorCodeValue` and the
// OpenAPI `code` enum can no longer drift apart.
const apiErrorCodeValues = Object.values(ApiErrorCode) as [
  ApiErrorCodeValue,
  ...ApiErrorCodeValue[],
];
const ApiErrorCodeEnum = z.enum(apiErrorCodeValues);

const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      code: ApiErrorCodeEnum.openapi({
        example: 'VALIDATION_ERROR',
        description:
          'Closed set; see `ApiErrorCode` in `@loop/shared/api.ts`. Web client should `switch` on this rather than comparing to string literals.',
      }),
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
//
// Schemas + path registrations for `/api/auth/*` live in
// `./openapi/auth.ts`. `registerAuthOpenApi` is called below
// once (after shared components are defined) and registers both
// halves on this module's registry instance.

// ─── Merchants ──────────────────────────────────────────────────────────────
//
// Schemas + path registrations for `/api/merchants/*` live in
// `./openapi/merchants.ts`. `registerMerchantsOpenApi` is called
// below alongside the other section factories.
//
// `Pagination` stays here as a shared schema because the Orders
// section also uses it. Future slices may consolidate into a
// shared primitives module.
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

// ─── Cross-section enums ────────────────────────────────────────────────────
//
// Inline (NOT registered) zod schemas reused across multiple
// section factories. Kept here so a single declaration drives
// every consumer (Users + Admin for the LOOP-asset / payout-state
// enums; Merchants + Admin for the cashback-percent string). Any
// future slice that needs one of these takes it as a parameter
// rather than redeclaring it.

const LoopAssetCode = z
  .enum(['USDLOOP', 'GBPLOOP', 'EURLOOP'])
  .openapi({ description: 'LOOP-branded fiat stablecoin code (ADR 015).' });

const PayoutState = z
  .enum(['pending', 'submitted', 'confirmed', 'failed'])
  .openapi({ description: 'pending_payouts row lifecycle (ADR 015/016).' });

const CashbackPctString = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,2})?$/)
  .openapi({
    description:
      'Percentage in the range [0, 100] with ≤2 decimal places, serialised as a string to match the Postgres numeric(5,2) wire shape (e.g. `"80.00"`).',
  });

// ─── Orders ─────────────────────────────────────────────────────────────────
//
// Schemas + path registrations for `/api/orders/*` (legacy
// CTX-proxy) and `/api/orders/loop/*` (ADR 015 Loop-native) live
// in `./openapi/orders.ts`. `registerOrdersOpenApi` is called
// below alongside the other section factories.

// ─── Users ──────────────────────────────────────────────────────────────────
//
// Schemas + path registrations for `/api/users/me/*` live in
// `./openapi/users.ts`. `registerUsersOpenApi` is called below
// alongside the other section factories. The factory takes the
// `LoopAssetCode` + `PayoutState` enums declared above (the same
// instances are shared with the Admin factory).

// ─── Public ─────────────────────────────────────────────────────────────────
//
// Schemas + path registrations for `/api/public/*` (the never-500,
// CDN-friendly, no-PII marketing surface — ADR 020) live in
// `./openapi/public.ts`. `registerPublicOpenApi` is called below
// alongside the other section factories. The factory only depends
// on `ErrorResponse`; the section dividers from openapi.ts (the
// "landing-page aggregates" + "top cashback merchants" headers)
// are preserved verbatim inside the module so generated docs stay
// readable.

// ─── Admin ──────────────────────────────────────────────────────────────────
//
// Schemas + path registrations for `/api/admin/*` (treasury,
// payouts, cashback-config CRUD, drill metrics, audit tail, CSV
// exports) live in `./openapi/admin.ts`. `registerAdminOpenApi`
// is called below alongside the other section factories and takes
// the cross-section enums (LoopAssetCode, PayoutState,
// CashbackPctString) declared above so neither file ends up with
// a duplicate definition.

// ─── Health / config ────────────────────────────────────────────────────────
//
// Schemas + path registrations for the three meta endpoints —
// `GET /health`, `GET /metrics`, `GET /api/config` — live in
// `./openapi/health.ts`. `registerHealthOpenApi` is called below
// alongside the other section factories.

// ─── Clusters / images ──────────────────────────────────────────────────────
//
// Schemas + path registrations for `GET /api/clusters` and
// `GET /api/image` live in `./openapi/clusters.ts`.
// `registerClustersOpenApi` is called below alongside the other
// section factories.

// ─── Spec generator ─────────────────────────────────────────────────────────

// Register the bearer auth scheme on the registry so the generator
// emits it under components.securitySchemes.
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Upstream CTX access token. Obtain via POST /api/auth/verify-otp and refresh via POST /api/auth/refresh.',
});

// Per-domain section registrations (A2-1165-style decomposition of
// the openapi.ts monolith). Each module takes the shared registry +
// shared schemas and adds its own zod definitions + path entries.
// Called here so every section runs after the shared components
// above are defined and before the generator walks the definitions.
registerAuthOpenApi(registry, ErrorResponse, PlatformEnum);
registerMerchantsOpenApi(registry, ErrorResponse, CashbackPctString, Pagination);
registerOrdersOpenApi(registry, ErrorResponse, Pagination);
registerUsersOpenApi(registry, ErrorResponse, LoopAssetCode, PayoutState);
registerPublicOpenApi(registry, ErrorResponse);
registerAdminOpenApi(registry, ErrorResponse, LoopAssetCode, PayoutState, CashbackPctString);
registerHealthOpenApi(registry, ErrorResponse);
registerClustersOpenApi(registry, ErrorResponse);

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
