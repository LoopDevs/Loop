import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('map', 'routes/map.tsx'),
  route('gift-card/:name', 'routes/gift-card.$name.tsx'),
  route('auth', 'routes/auth.tsx'),
] satisfies RouteConfig;
