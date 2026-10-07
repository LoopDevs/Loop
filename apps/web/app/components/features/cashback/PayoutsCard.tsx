import type { PayoutStatus, PayoutView } from '@loop/shared';
import { useAccount } from '~/hooks/use-account';
import { formatAccountAmount, formatDateTime, useLocaleTag } from '~/i18n/format';
import { Spinner } from '~/components/ui/Spinner';

const PENDING_CLASSES = 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
const STOPPED_CLASSES = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';

const PAYOUT_STATUS_UI: Record<PayoutStatus, { label: string; classes: string }> = {
  'pending-approval': { label: 'Awaiting approval', classes: PENDING_CLASSES },
  approved: { label: 'Approved', classes: PENDING_CLASSES },
  held: { label: 'Held', classes: PENDING_CLASSES },
  pending: { label: 'Sending', classes: PENDING_CLASSES },
  complete: {
    label: 'Paid',
    classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
  failed: {
    label: 'Failed',
    classes: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  rejected: { label: 'Rejected', classes: STOPPED_CLASSES },
  cancelled: { label: 'Cancelled', classes: STOPPED_CLASSES },
};

export function PayoutsCard(): React.JSX.Element | null {
  const { account, isLoading, isError } = useAccount();

  if (isLoading) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }
  if (isError || account === undefined || account.payouts.length === 0) return null;

  return (
    <section
      aria-labelledby="payouts-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
    >
      <h2
        id="payouts-heading"
        className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Payouts
      </h2>
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- ADR 042: Tailwind Preflight strips the implicit list role in Safari VoiceOver. */}
      <ul role="list" className="divide-y divide-gray-200 dark:divide-gray-800">
        {account.payouts.map((row) => (
          <PayoutRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function PayoutRow({ row }: { row: PayoutView }): React.JSX.Element {
  const locale = useLocaleTag();
  const ui = PAYOUT_STATUS_UI[row.status];
  const explorerHref =
    row.txHash === null
      ? null
      : `https://stellar.expert/explorer/public/tx/${encodeURIComponent(row.txHash)}`;
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
          {formatAccountAmount(row.amount, row.currency, locale)}
        </p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {formatDateTime(row.finalised ?? row.created, locale, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {explorerHref !== null && (
            <>
              {' · '}
              <a
                href={explorerHref}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200"
              >
                View tx
              </a>
            </>
          )}
        </p>
        {row.status === 'failed' ? (
          <p className="mt-1 text-xs text-red-700 dark:text-red-400">
            This payout didn&rsquo;t land. Support is reviewing.
          </p>
        ) : null}
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${ui.classes}`}>
        {ui.label}
      </span>
    </li>
  );
}
