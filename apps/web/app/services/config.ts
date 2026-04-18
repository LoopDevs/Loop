/**
 * Base URL of the Loop backend API. Injected at build time by Vite.
 *
 * If a production build ships without `VITE_API_URL` set, falling back to
 * the empty string quietly broke every API call — every request became
 * relative (`/api/...`) and hit the web origin (loopfinance.io or, worse
 * on native, the capacitor://localhost scheme that has no backend). Prefer
 * the known prod origin in that case; CSP already does the same for the
 * same reason. Dev explicitly sets `VITE_API_URL=http://localhost:8080`
 * in `.env.local`, so this fallback only kicks in if an operator
 * forgets to set it for a production build.
 *
 * Matches the CSP fallback in `apps/web/app/root.tsx` so header and
 * runtime URLs can't drift.
 */
export const API_BASE =
  import.meta.env['VITE_API_URL'] ?? (import.meta.env.PROD ? 'https://api.loopfinance.io' : '');
