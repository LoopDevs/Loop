import { useQuery } from '@tanstack/react-query';
import { isLoopAssetCode, currencyForLoopAsset } from '@loop/shared';
import { getMyCredits, type UserCreditRow } from '~/services/user';
import { useAuth } from '~/hooks/use-auth';
import { useWallet } from '~/hooks/use-wallet';
import { shouldRetry } from '~/hooks/query-retry';
import { fmtLoopBalance } from '~/components/features/wallet/WalletCard';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Formats a non-negative minor-unit amount as localised currency.
 * The balance card always shows a currency symbol so Intl is the
 * right tool; fall back to "<value> <code>" if Intl rejects the
 * currency (shouldn't happen — we only ever emit USD/GBP/EUR —
 * but the guard keeps the UI readable on a bad backend response).
 */
export function fmtBalance(balanceMinor: string, currency: string): string {
  const n = Number(balanceMinor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * "Your cashback balance" card for /settings/cashback. Renders a
 * single tile per currency — most users will only ever see one, but
 * the layout scales to the multi-currency edge case (home-currency
 * flip, admin adjustment in a non-home currency).
 *
 * Never surfaces a loud error — cashback history below is the
 * authoritative ledger view. A quiet em-dash is better than a red
 * banner above the ledger that the ledger itself will disprove.
 */
export function CashbackBalanceCard(): React.JSX.Element {
  // A2-1156: gate on isAuthenticated so cold-start doesn't fire a 401
  // before session restore completes.
  const { isAuthenticated } = useAuth();
  // balance = tokens once activated; mirror is reconciliation-only
  // (ADR 036). Once the embedded wallet is `activated`, the user's
  // balance IS the on-chain LOOP they hold — the tiles below source
  // from the wallet's LOOP-asset balances. Pre-activation users keep
  // the `user_credits` mirror display (their tokens haven't been
  // emitted yet).
  const { wallet, isActivated } = useWallet();
  const tokenSourced = isActivated && wallet !== undefined;
  const query = useQuery({
    queryKey: ['me', 'credits'],
    queryFn: getMyCredits,
    // The mirror read is only needed while the display is
    // mirror-sourced — skip it entirely once tokens are authoritative.
    enabled: isAuthenticated && !tokenSourced,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  // One row shape for both sources: ISO currency label + formatted
  // major-unit amount.
  let rows: Array<{ currency: string; formatted: string }>;
  if (tokenSourced) {
    rows = wallet.balances.flatMap((b) =>
      isLoopAssetCode(b.assetCode)
        ? [
            {
              currency: currencyForLoopAsset(b.assetCode),
              formatted: fmtLoopBalance(b.balance, b.assetCode),
            },
          ]
        : [],
    );
  } else {
    if (query.isPending) {
      return (
        <section className="flex justify-center py-4">
          <Spinner />
        </section>
      );
    }

    // Silent fail — the off-chain ledger view below tells the full story.
    if (query.isError) return <></>;

    rows = query.data.credits.map((r: UserCreditRow) => ({
      currency: r.currency,
      formatted: fmtBalance(r.balanceMinor, r.currency),
    }));
  }

  return (
    <section
      aria-labelledby="balance-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5"
    >
      <h2
        id="balance-heading"
        className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Your cashback balance
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          No cashback yet. Your first Loop order will show up here.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {rows.map((r) => (
            <div
              key={r.currency}
              className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-4 py-3"
            >
              <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {r.currency}
              </div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums text-gray-900 dark:text-white">
                {r.formatted}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
