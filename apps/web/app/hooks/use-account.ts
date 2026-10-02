import { useQuery } from '@tanstack/react-query';
import { activeWalletLink, type UserAccountView, type WalletLinkView } from '@loop/shared';
import { getMyAccount } from '~/services/user';
import { useAuth } from './use-auth';
import { useAppConfig } from './use-app-config';
import { shouldRetry } from './query-retry';

export const ACCOUNT_QUERY_KEY = ['me', 'account'] as const;

export interface UseAccountResult {
  account: UserAccountView | undefined;
  activeLink: WalletLinkView | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useAccount(): UseAccountResult {
  const { isAuthenticated } = useAuth();
  const { config } = useAppConfig();
  const query = useQuery({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: getMyAccount,
    enabled: isAuthenticated && !config.phase1Only,
    retry: shouldRetry,
    staleTime: 30_000,
  });
  const account = query.data;
  return {
    account,
    activeLink: account === undefined ? null : activeWalletLink(account.linkedWallets),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: (): void => {
      void query.refetch();
    },
  };
}
