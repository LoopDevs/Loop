import { type RouteConfig, index, route } from '@react-router/dev/routes';

const isMobile = process.env.BUILD_TARGET === 'mobile';

// The sitemap is an SSR-only resource route — it exports a `loader`,
// which SPA mode (mobile static export) rejects. Skip it at build
// time when BUILD_TARGET=mobile. Mobile doesn't serve HTTP, so it
// has no use for a sitemap anyway.
const sitemapRoutes = isMobile ? [] : [route('sitemap.xml', 'routes/sitemap.tsx')];

// FE-03: the OS App-Link / Universal-Link domain-verification files,
// served at the marketing hosts (loopfinance.io / www / beta) this web
// app owns — the hosts the native intent-filter + associated-domains
// entitlement declare, and therefore the hosts Apple/Google fetch the
// verification file from. SSR-only resource routes (export a `loader`),
// so — like the sitemap — they're excluded from the mobile SPA build,
// which rejects `loader` exports and doesn't serve HTTP anyway. The
// paths carry literal dots + no extension (apple-app-site-association);
// `route()` takes the URL path verbatim so no filename escaping is
// needed. See apps/web/app/services/deep-link-association.ts.
const wellKnownRoutes = isMobile
  ? []
  : [
      route('.well-known/assetlinks.json', 'routes/well-known.assetlinks.tsx'),
      route(
        '.well-known/apple-app-site-association',
        'routes/well-known.apple-app-site-association.tsx',
      ),
    ];

// FE-24: styleguide now exports a `loader` that 404s the design-system
// page in production. SPA mode (mobile static export) rejects `loader`
// exports, and the mobile app has no use for the web-only styleguide, so
// skip it when BUILD_TARGET=mobile (same pattern as sitemap/not-found-ssr).
const styleguideRoutes = isMobile ? [] : [route('styleguide', 'routes/styleguide.tsx')];

// A2-1111: SSR build wires the splat to `not-found-ssr.tsx`, whose
// loader throws a real HTTP 404 so crawlers stop seeing soft-200s.
// Mobile build uses the plain `not-found.tsx` because SPA mode rejects
// `loader` exports. Both files render the same 404 UI.
const splatRoute = isMobile
  ? route('*', 'routes/not-found.tsx')
  : route('*', 'routes/not-found-ssr.tsx');

// P2-10/P2-11: the conversion pages (`/gift-card/:name`, `/brand/:slug`,
// `/cashback/:slug`) resolve their slug client-side, so SSR served an unknown
// entry as a soft-404 (HTTP 200 with "not found" content) that crawlers indexed.
// The SSR build wires each to its `-ssr` variant, whose loader resolves the slug
// server-side and throws a real HTTP 404 for an unknown entry (same idiom as
// `not-found-ssr.tsx`). Mobile (SPA, no `loader`) keeps the component-only file;
// both render the same page. Used for the legacy + localised mounts below.
const giftCardModule = isMobile ? 'routes/gift-card.$name.tsx' : 'routes/gift-card.$name-ssr.tsx';
const brandModule = isMobile ? 'routes/brand.$slug.tsx' : 'routes/brand.$slug-ssr.tsx';
const cashbackSlugModule = isMobile ? 'routes/cashback.$slug.tsx' : 'routes/cashback.$slug-ssr.tsx';

// ADR 034 — the public marketing surface is also reachable under a
// `/:country/:lang` locale prefix (e.g. `/gb/en/cashback`). These mirror the
// legacy top-level routes below: both forms resolve during the migration so
// every pre-ADR-034 URL + internal <Link> keeps working, while Phase 3 routes
// links through `localizedHref()` to emit the prefixed form. Each locale copy
// carries an `locale/` id so React Router can tell the two mounts of the same
// module apart.
//
// Scope: only the public catalogue + onboarding are localised — that's where
// per-country SEO and price-display currency matter. The authed app
// (auth/orders/settings) and admin stay single-locale: their currency comes
// from the user's home-currency setting, not the URL, and admin is single-market
// ops.
const localeChildren: RouteConfig = [
  index('routes/home.tsx', { id: 'locale/home' }),
  route('map', 'routes/map.tsx', { id: 'locale/map' }),
  route('gift-card/:name', giftCardModule, { id: 'locale/gift-card' }),
  route('brand/:slug', brandModule, { id: 'locale/brand' }),
  route('cashback', 'routes/cashback.tsx', { id: 'locale/cashback' }),
  route('cashback/:slug', cashbackSlugModule, { id: 'locale/cashback-slug' }),
  route('calculator', 'routes/calculator.tsx', { id: 'locale/calculator' }),
  route('trustlines', 'routes/trustlines.tsx', { id: 'locale/trustlines' }),
  route('privacy', 'routes/privacy.tsx', { id: 'locale/privacy' }),
  route('terms', 'routes/terms.tsx', { id: 'locale/terms' }),
  route('onboarding', 'routes/onboarding.tsx', { id: 'locale/onboarding' }),
];

// The locale layout validates the country/lang segments. SSR throws a real 404
// for an unrouted locale; mobile (SPA, no loader) renders the 404 UI in-component.
const localeLayout = route(
  ':country/:lang',
  isMobile ? 'routes/locale-layout.tsx' : 'routes/locale-layout-ssr.tsx',
  localeChildren,
);

// Root `/`: SSR geo-redirects to `/<country>/en` (bots get the x-default home);
// mobile renders home directly (no SSR to redirect — the shell pins a locale).
const rootIndex = isMobile ? index('routes/home.tsx') : index('routes/home-geo-redirect.tsx');

export default [
  rootIndex,
  localeLayout,
  // Legacy top-level public routes — unchanged, kept working during the ADR 034
  // migration (mirrored by `localeChildren` above).
  route('map', 'routes/map.tsx'),
  route('gift-card/:name', giftCardModule),
  route('brand/:slug', brandModule),
  route('cashback', 'routes/cashback.tsx'),
  route('cashback/:slug', cashbackSlugModule),
  route('calculator', 'routes/calculator.tsx'),
  route('trustlines', 'routes/trustlines.tsx'),
  route('privacy', 'routes/privacy.tsx'),
  route('terms', 'routes/terms.tsx'),
  ...sitemapRoutes,
  ...wellKnownRoutes,
  route('auth', 'routes/auth.tsx'),
  // Internal design-system kitchen-sink (noindex; gate/remove before public launch).
  ...styleguideRoutes,
  route('onboarding', 'routes/onboarding.tsx'),
  route('orders', 'routes/orders.tsx'),
  route('orders/:id', 'routes/orders.$id.tsx'),
  route('settings/wallet', 'routes/settings.wallet.tsx'),
  route('settings/cashback', 'routes/settings.cashback.tsx'),
  route('settings/privacy', 'routes/settings.privacy.tsx'),
  route('admin', 'routes/admin._index.tsx'),
  route('admin/cashback', 'routes/admin.cashback.tsx'),
  route('admin/treasury', 'routes/admin.treasury.tsx'),
  route('admin/payouts', 'routes/admin.payouts.tsx'),
  route('admin/payouts/:id', 'routes/admin.payouts.$id.tsx'),
  route('admin/orders', 'routes/admin.orders.tsx'),
  route('admin/orders/:orderId', 'routes/admin.orders.$orderId.tsx'),
  route('admin/stuck-orders', 'routes/admin.stuck-orders.tsx'),
  route('admin/merchants', 'routes/admin.merchants.tsx'),
  route('admin/merchants/:merchantId', 'routes/admin.merchants.$merchantId.tsx'),
  route('admin/users', 'routes/admin.users.tsx'),
  route('admin/users/:userId', 'routes/admin.users.$userId.tsx'),
  route('admin/skips', 'routes/admin.skips.tsx'),
  route('admin/ledger', 'routes/admin.ledger.tsx'),
  route('admin/operators', 'routes/admin.operators.tsx'),
  route('admin/operators/:operatorId', 'routes/admin.operators.$operatorId.tsx'),
  route('admin/assets', 'routes/admin.assets.tsx'),
  route('admin/assets/:assetCode', 'routes/admin.assets.$assetCode.tsx'),
  route('admin/audit', 'routes/admin.audit.tsx'),
  route('admin/staff', 'routes/admin.staff.tsx'),
  splatRoute,
] satisfies RouteConfig;
