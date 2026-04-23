import { type RouteConfig, index, route } from '@react-router/dev/routes';

// The sitemap is an SSR-only resource route — it exports a `loader`,
// which SPA mode (mobile static export) rejects. Skip it at build
// time when BUILD_TARGET=mobile. Mobile doesn't serve HTTP, so it
// has no use for a sitemap anyway.
const sitemapRoutes =
  process.env.BUILD_TARGET === 'mobile' ? [] : [route('sitemap.xml', 'routes/sitemap.tsx')];

export default [
  index('routes/home.tsx'),
  route('map', 'routes/map.tsx'),
  route('gift-card/:name', 'routes/gift-card.$name.tsx'),
  route('cashback', 'routes/cashback.tsx'),
  route('cashback/:slug', 'routes/cashback.$slug.tsx'),
  route('trustlines', 'routes/trustlines.tsx'),
  route('privacy', 'routes/privacy.tsx'),
  route('terms', 'routes/terms.tsx'),
  ...sitemapRoutes,
  route('auth', 'routes/auth.tsx'),
  route('onboarding', 'routes/onboarding.tsx'),
  route('orders', 'routes/orders.tsx'),
  route('orders/:id', 'routes/orders.$id.tsx'),
  route('settings/wallet', 'routes/settings.wallet.tsx'),
  route('settings/cashback', 'routes/settings.cashback.tsx'),
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
  route('admin/operators/:operatorId', 'routes/admin.operators.$operatorId.tsx'),
  route('admin/audit', 'routes/admin.audit.tsx'),
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
