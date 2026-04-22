import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('map', 'routes/map.tsx'),
  route('gift-card/:name', 'routes/gift-card.$name.tsx'),
  route('auth', 'routes/auth.tsx'),
  route('onboarding', 'routes/onboarding.tsx'),
  route('orders', 'routes/orders.tsx'),
  route('orders/:id', 'routes/orders.$id.tsx'),
  route('settings/wallet', 'routes/settings.wallet.tsx'),
  route('settings/cashback', 'routes/settings.cashback.tsx'),
  route('admin/cashback', 'routes/admin.cashback.tsx'),
  route('admin/treasury', 'routes/admin.treasury.tsx'),
  route('admin/payouts', 'routes/admin.payouts.tsx'),
  route('admin/orders', 'routes/admin.orders.tsx'),
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
