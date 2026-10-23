/**
 * `useAppConfig` — public config from the backend, cached in
 * react-query. Defaults while loading / on error to the safe
 * fallbacks below — a missing value never unlocks a new path.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchAppConfig, type AppConfig } from '~/services/config';

const DEFAULT_CONFIG: AppConfig = {
  // ADR 052 — safe default matching the backend's own fallback
  // (`LOOP_CTX_PAYMENT_CURRENCIES ?? 'XLM'`). A missing config keeps
  // checkout on the universally-supported currency rather than
  // offering rails the deployment may not accept.
  ctxPaymentCurrencies: ['XLM'],
  fiatPaymentCurrencies: [],
  countries: [],
  stableCurrencies: [],
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
