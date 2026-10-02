import { Link } from 'react-router';
import { hasPositiveAccountBalance } from '@loop/shared';
import { useAccount } from '~/hooks/use-account';
import { useAppConfig } from '~/hooks/use-app-config';

export function LinkWalletNudge(): React.JSX.Element | null {
  const { config } = useAppConfig();
  const { account, activeLink, isLoading, isError } = useAccount();

  if (config.phase1Only) return null;
  if (isLoading || isError || account === undefined) return null;
  if (activeLink !== null) return null;
  if (!hasPositiveAccountBalance(account.wallet)) return null;

  return (
    <section
      role="note"
      aria-labelledby="link-wallet-heading"
      className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 dark:border-blue-900/60 dark:bg-blue-900/20"
    >
      <h2
        id="link-wallet-heading"
        className="text-sm font-semibold text-blue-900 dark:text-blue-200"
      >
        Link a Stellar wallet to receive payouts
      </h2>
      <p className="mt-1 text-sm text-blue-800 dark:text-blue-300">
        You&rsquo;ve earned cashback. Link a Stellar wallet and it pays out on-chain automatically.
      </p>
      <Link
        to="/settings/wallet"
        className="mt-3 inline-flex items-center rounded-lg border border-blue-600 bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-blue-400 dark:bg-blue-500 dark:hover:bg-blue-600"
      >
        Go to wallet settings
      </Link>
    </section>
  );
}
