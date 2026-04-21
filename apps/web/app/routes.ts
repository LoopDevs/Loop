import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('map', 'routes/map.tsx'),
  route('gift-card/:name', 'routes/gift-card.$name.tsx'),
  route('auth', 'routes/auth.tsx'),
  route('onboarding', 'routes/onboarding.tsx'),
  route('orders', 'routes/orders.tsx'),
  route('orders/:id', 'routes/orders.$id.tsx'),
  route('admin/cashback', 'routes/admin.cashback.tsx'),
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
