import { useQuery } from '@tanstack/react-query';
import { getMyWallet, type UserWalletResponse } from '~/services/wallet';
import { useAuth } from './use-auth';
import { shouldRetry } from './query-retry';

/**
 * Shared cache key for the embedded-wallet surface (ADR 030 Phase C).
 * Me-surface convention: 2-element array where the first element is
 * the scope selector (matches `['me', 'credits']` etc.). Exported so
 * the redeem flow can invalidate it after a spend.
 */
export const WALLET_QUERY_KEY = ['me', 'wallet'] as const;

export interface UseWalletResult {
  /** `GET /api/me/wallet` payload; undefined while loading or on error. */
  wallet: UserWalletResponse | undefined;
  /** True once provisioning completed and balances are authoritative. */
  isActivated: boolean;
  /**
   * Horizon decimal balance string for an asset code, `'0'` when the
   * wallet has no row for it (or hasn't loaded yet).
   */
  balanceFor: (assetCode: string) => string;
  isLoading: boolean;
  isError: boolean;
  /** The load failure, when `isError` — lets callers tell a transient
   *  blip (offer retry) from a permanent 4xx (stay quiet). */
  error: Error | null;
  /** Re-triggers the wallet fetch (e.g. from a retry affordance). */
  refetch: () => void;
}

/**
 * Reads the caller's embedded-wallet surface: address, provisioning
 * state, on-chain LOOP balances (the user's authoritative balance),
 * interest APY. Auth-gated internally so cold-start / signed-out
 * renders never fire a guaranteed-401 request.
 *
 * 30s staleTime: balances move on order payment and nightly interest;
 * the redeem mutation invalidates explicitly, so a 30s
 * window only ever shows a slightly stale read between unrelated
 * navigations.
 */
export function useWallet(): UseWalletResult {
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: WALLET_QUERY_KEY,
    queryFn: getMyWallet,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const wallet = query.data;
  return {
    wallet,
    isActivated: wallet?.provisioning === 'activated',
    balanceFor: (assetCode: string): string =>
      wallet?.balances.find((b) => b.assetCode === assetCode)?.balance ?? '0',
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: (): void => {
      void query.refetch();
    },
  };
}
