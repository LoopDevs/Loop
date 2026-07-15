import { isLoopAssetCode, currencyForLoopAsset } from '@loop/shared';
import { useWallet } from '~/hooks/use-wallet';
import { isTransientError } from '~/hooks/query-retry';
import { Button } from '~/components/ui/Button';
import { formatCurrency, useLocaleTag } from '~/i18n/format';
import { VaultApyRow } from './VaultApyRow';

/**
 * Formats a Horizon decimal balance string (`"42.5000000"`) for a
 * LOOP asset as localised fiat currency — GBPLOOP renders as `£42.50`,
 * never as "GBPLOOP" with wallet jargon. LOOP assets are 1:1
 * fiat-backed (ADR 015) so the fiat presentation IS the balance.
 * Number-cast is safe here: per-user balances sit far inside the 2^53
 * window (the bigint-safe path matters for fleet-wide sums only).
 */
export function fmtLoopBalance(balance: string, assetCode: string, locale: string): string {
  if (!isLoopAssetCode(assetCode)) return `${balance} ${assetCode}`;
  const currency = currencyForLoopAsset(assetCode);
  const n = Number(balance);
  if (!Number.isFinite(n)) return '—';
  return formatCurrency(n, currency, locale);
}

/**
 * Basis points → human percentage. `300` → `"3"`, `325` → `"3.25"`.
 * Trailing zeros trimmed so the common integer APYs read clean.
 */
export function fmtApyBps(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/**
 * "Your Loop balance" card (ADR 030 Phase C, plan §C4) for the home
 * and account surfaces. The on-chain LOOP-asset balance shown here is
 * the user's authoritative balance — the off-chain mirror is never
 * user-visible.
 *
 * Self-gating: renders nothing while signed out or while the query is
 * in flight. A PERMANENT load failure (4xx — most importantly the 404
 * during the deploy-order gap before the endpoint's sibling backend PR
 * ships; also auth) stays quiet too: a retry could never succeed, so a
 * retry button would lie and an error banner would needlessly alarm.
 * A TRANSIENT failure (5xx / network blip) instead keeps the card on
 * screen with a retry (AUD-10) — silently unmounting the balance reads
 * as "my money vanished", which is worse than an honest hiccup notice.
 * Provisioning states (`none` / `wallet_created`) render a quiet
 * "setting up" line — they never block browsing or buying.
 */
export function WalletCard(): React.JSX.Element | null {
  const { wallet, isActivated, isLoading, isError, error, refetch } = useWallet();
  const locale = useLocaleTag();

  // A transient load failure must not silently unmount the balance —
  // keep the surface visible with a clear, reassuring retry (AUD-10).
  if (isError && isTransientError(error)) {
    return (
      <section
        aria-labelledby="wallet-balance-heading"
        className="mb-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-4 text-start"
      >
        <h2
          id="wallet-balance-heading"
          className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
        >
          Your Loop balance
        </h2>
        <p role="alert" className="mt-1 text-sm font-medium text-red-600 dark:text-red-400">
          We couldn’t load your balance just now.
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Your money is safe — this is only a display hiccup.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            refetch();
          }}
        >
          Retry
        </Button>
      </section>
    );
  }

  // Quiet on loading, a permanent (4xx) error, or when signed out (the
  // hook disables the query when signed out, which surfaces here as
  // perpetual loading).
  if (isLoading || isError || wallet === undefined) return null;

  const loopRows = wallet.balances.filter((b) => isLoopAssetCode(b.assetCode));
  const interestLine =
    wallet.interestApyBps > 0 ? (
      <p className="mt-1 text-xs text-green-700 dark:text-green-400">
        Earns {fmtApyBps(wallet.interestApyBps)}% APR, paid nightly.
      </p>
    ) : null;

  return (
    <section
      aria-labelledby="wallet-balance-heading"
      className="mb-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-4 text-start"
    >
      <h2
        id="wallet-balance-heading"
        className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Your Loop balance
      </h2>
      {!isActivated ? (
        // Provisioning runs async post-signup (plan §C1) — nothing for
        // the user to do, nothing is blocked, no wallet jargon.
        <>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">—</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Setting up your wallet — you can keep shopping, this finishes on its own.
          </p>
        </>
      ) : loopRows.length === 0 ? (
        <>
          <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">—</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            No balance yet — cashback you earn lands here automatically.
          </p>
          {interestLine}
        </>
      ) : (
        <>
          {loopRows.map((row, i) => (
            <div key={row.assetCode}>
              <p
                className={
                  i === 0
                    ? 'mt-1 text-2xl font-semibold tabular-nums text-gray-900 dark:text-white'
                    : 'mt-0.5 text-base font-semibold tabular-nums text-gray-700 dark:text-gray-300'
                }
              >
                {fmtLoopBalance(row.balance, row.assetCode, locale)}
              </p>
              {/* ADR 031 §User-facing display, V6: past-30-day APY +
                  disclaimer for whichever LOOP-branded balances this
                  deployment can currently pay yield on. Self-gating —
                  renders nothing outside its own conditions (dark
                  behind LOOP_PHASE_1_ONLY, no history yet, etc). */}
              <VaultApyRow assetCode={row.assetCode} />
            </div>
          ))}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Spend it on any gift card, one tap at checkout.
          </p>
          {interestLine}
        </>
      )}
    </section>
  );
}
