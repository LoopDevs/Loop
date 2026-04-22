import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getMe } from '~/services/user';
import { getMyCredits, type UserCreditRow } from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Returns true when the user has any positive off-chain balance across
 * any currency. Uses BigInt so a balance that exceeds the JS safe
 * integer range still compares correctly.
 */
export function hasPositiveBalance(rows: UserCreditRow[] | undefined): boolean {
  if (rows === undefined || rows.length === 0) return false;
  for (const r of rows) {
    try {
      if (BigInt(r.balanceMinor) > 0n) return true;
    } catch {
      /* malformed row — skip */
    }
  }
  return false;
}

/**
 * Prompts the user to link a Stellar wallet once they've earned
 * cashback. Hides itself entirely when the user has no positive
 * balance (nothing to withdraw yet), or has already linked an
 * address (nudge complete), or either query is still in flight
 * (no flash-then-hide noise).
 *
 * Deliberately no dismiss button: the prompt goes away automatically
 * as soon as the user acts, and a dismiss would bury a growing
 * unreachable balance. The user can also ignore it safely — cashback
 * accrues off-chain whether or not a wallet is linked.
 */
export function LinkWalletNudge(): React.JSX.Element | null {
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: shouldRetry,
    staleTime: 60_000,
  });
  const creditsQuery = useQuery({
    queryKey: ['me', 'credits'],
    queryFn: getMyCredits,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (meQuery.isPending || creditsQuery.isPending) return null;
  if (meQuery.isError || creditsQuery.isError) return null;
  if (meQuery.data.stellarAddress !== null) return null;
  if (!hasPositiveBalance(creditsQuery.data.credits)) return null;

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
        Link a Stellar wallet to withdraw
      </h2>
      <p className="mt-1 text-sm text-blue-800 dark:text-blue-300">
        You&rsquo;ve earned cashback. Connect a Stellar wallet and future payouts land on-chain
        automatically.
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
