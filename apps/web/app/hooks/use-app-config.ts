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
  social: {
    googleClientIdWeb: null,
    googleClientIdIos: null,
    googleClientIdAndroid: null,
    appleServiceId: null,
  },
  loopAssetIssuers: {
    USDLOOP: null,
    GBPLOOP: null,
    EURLOOP: null,
  },
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
