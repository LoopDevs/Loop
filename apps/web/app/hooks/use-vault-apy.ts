import { useQuery } from '@tanstack/react-query';
import { getVaultApy, type VaultApyResponse } from '~/services/vault-apy';
import { useAuth } from './use-auth';
import { useAppConfig } from './use-app-config';
import { shouldRetry } from './query-retry';

/**
 * Shared cache key for the vault-APY surface (ADR 031 V6). Me-surface
 * convention: 2-element array where the first element is the scope
 * selector (matches `['me', 'wallet']`, `['me', 'credits']`).
 */
export const VAULT_APY_QUERY_KEY = ['me', 'vault-apy'] as const;

export interface UseVaultApyResult {
  /** `GET /api/me/vault-apy` payload; undefined while loading or on error. */
  vaultApy: VaultApyResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Reads the caller's past-30-day/90-day APY figures for whichever
 * LOOP-branded yield assets this deployment can currently pay APY on
 * (ADR 031 §Detailed design D8).
 *
 * Double-gated so no request ever fires for a surface that isn't going
 * to render: `enabled` requires both an authenticated caller (cold
 * start / signed-out would otherwise fire a guaranteed-401 request,
 * same discipline as `useWallet`) AND `!config.phase1Only` — the vault
 * yield surface is dark behind `LOOP_PHASE_1_ONLY`, same Phase-1 build
 * gate the rest of the cashback/wallet surface uses (see
 * `~/components/Phase2Gate` / `LinkWalletNudge`'s `config.phase1Only`
 * check). `useAppConfig` defaults `phase1Only` to `true`, so SSR / first
 * paint / a config-fetch failure all correctly keep this query disabled
 * until config confirms Phase 2 is live.
 *
 * 5-minute staleTime: the underlying figures come from a daily
 * snapshot cron (`vault-apy-snapshot`, V5b) — there's no value in
 * refetching more often than that within a single session.
 */
export function useVaultApy(): UseVaultApyResult {
  const { isAuthenticated } = useAuth();
  const { config } = useAppConfig();
  const query = useQuery({
    queryKey: VAULT_APY_QUERY_KEY,
    queryFn: getVaultApy,
    enabled: isAuthenticated && !config.phase1Only,
    retry: shouldRetry,
    staleTime: 5 * 60_000,
  });

  return {
    vaultApy: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
