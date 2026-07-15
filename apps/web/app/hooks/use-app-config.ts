/**
 * `useAppConfig` — feature flags from the backend, cached in
 * react-query. Called from anywhere in the tree that needs to
 * branch on a server-side flag (e.g. PurchaseContainer picking
 * between the legacy CTX-proxy flow and the Loop-native flow).
 *
 * Defaults while loading / on error to all-false — a missing flag
 * should keep the legacy path, never unlock a new one.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchAppConfig, type AppConfig } from '~/services/config';

const DEFAULT_CONFIG: AppConfig = {
  loopAuthNativeEnabled: false,
  loopOrdersEnabled: false,
  // Default to phase1Only=true — the current shipping reality
  // (api.loopfinance.io returns phase1Only:true). SSR + first client
  // paint can't fetch /api/config, so they render with this default;
  // matching it to the live value eliminates the visible flash where
  // Phase-2-only chrome (the "Rates" nav link, "Earn cashback" hero
  // copy, cashback footer links) paints for one frame and then
  // disappears once the real config resolves. `phase1Only` only
  // governs UI visibility — the cashback flow itself is independently
  // gated on `loopOrdersEnabled` / `loopAuthNativeEnabled`, so this
  // default unlocks nothing live; it only hides Phase-2 surfaces
  // until config confirms they're on. Flip back to `false` (or make
  // it deploy-aware) when Phase 2 ships.
  phase1Only: true,
  // Default all LOOP assets to unavailable — matches a deployment that
  // hasn't yet configured Stellar issuers. Components that branch on
  // `loopAssets.*.available` see "coming soon" until the real config
  // resolves (ADR 015).
  loopAssets: {
    USDLOOP: { issuer: null, available: false },
    GBPLOOP: { issuer: null, available: false },
    EURLOOP: { issuer: null, available: false },
  },
  social: {
    googleClientIdWeb: null,
    googleClientIdIos: null,
    googleClientIdAndroid: null,
    appleServiceId: null,
  },
  // P2-14: default to no gate. A missing / erroring config must never
  // fabricate a version floor that would lock users out of a working
  // build — fail open, same principle as every other flag here.
  minSupportedVersion: { ios: null, android: null },
};

export function useAppConfig(): { config: AppConfig; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['app-config'],
    queryFn: fetchAppConfig,
    // 10 minutes — matches the backend's Cache-Control. Prevents
    // every tab + every component from re-fetching on mount.
    staleTime: 10 * 60 * 1000,
    // Never retry config — if the backend can't serve it we fall
    // back to the safe defaults.
    retry: false,
  });
  return {
    config: query.data ?? DEFAULT_CONFIG,
    isLoading: query.isLoading,
  };
}
