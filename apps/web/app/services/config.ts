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
 * Per-LOOP-asset availability snapshot inside `AppConfig`. Mirrors the
 * backend `LoopAssetConfig` from `apps/backend/src/config/handler.ts`.
 */
export interface LoopAssetConfig {
  issuer: string | null;
  /** Convenience flag — `issuer !== null`. */
  available: boolean;
}

/**
 * Feature-flag snapshot from the backend (`GET /api/config`). These
 * gate the Loop-native code paths so the web app doesn't try to call
 * an endpoint that isn't active in the current deployment.
 */
export interface AppConfig {
  loopAuthNativeEnabled: boolean;
  loopOrdersEnabled: boolean;
  /**
   * Tranche 1 (MVP) launch gate. When true, the web client hides
   * every Phase 2+ surface (cashback navbar, /settings/wallet,
   * /settings/cashback, /cashback rates index, onboarding
   * currency-picker + wallet-intro screens, LinkWalletNudge,
   * "you've earned X cashback" copy). Discount badges stay —
   * they're the Tranche 1 user proposition. Toggled server-side
   * via `LOOP_PHASE_1_ONLY`; no app store resubmission needed
   * to flip it back when Tranche 2 launches.
   */
  phase1Only: boolean;
  /**
   * ADR 015 — which LOOP stablecoins are wired for on-chain payout.
   * Always returns all three keys so the client can render a stable
   * shape; a currency with `issuer: null` renders as "coming soon".
   */
  loopAssets: {
    USDLOOP: LoopAssetConfig;
    GBPLOOP: LoopAssetConfig;
    EURLOOP: LoopAssetConfig;
  };
  /** ADR 014 social-login client identifiers (public, per-platform). */
  social: {
    googleClientIdWeb: string | null;
    googleClientIdIos: string | null;
    googleClientIdAndroid: string | null;
    appleServiceId: string | null;
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
