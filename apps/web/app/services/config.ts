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

/**
 * Feature-flag snapshot from the backend (`GET /api/config`). These
 * gate the Loop-native code paths so the web app doesn't try to call
 * an endpoint that isn't active in the current deployment.
 */
export interface AppConfig {
  loopAuthNativeEnabled: boolean;
  loopOrdersEnabled: boolean;
  /** ADR 014 social-login client identifiers (public, per-platform). */
  social: {
    googleClientIdWeb: string | null;
    googleClientIdIos: string | null;
    googleClientIdAndroid: string | null;
    appleServiceId: string | null;
  };
  /**
   * ADR 015 LOOP-asset issuer accounts. Null per-asset when the
   * operator hasn't configured that issuer yet — the wallet page
   * hides the trustline prompt for any null code.
   */
  loopAssetIssuers: {
    USDLOOP: string | null;
    GBPLOOP: string | null;
    EURLOOP: string | null;
  };
}

/** Fetches the public app config. No auth required. */
export async function fetchAppConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/api/config`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`/api/config returned ${res.status}`);
  }
  return (await res.json()) as AppConfig;
}
