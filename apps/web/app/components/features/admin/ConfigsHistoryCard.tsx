import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getAdminConfigsHistory, type AdminConfigHistoryEntry } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const LIMIT = 10;

/**
 * Admin dashboard card — "recent config changes" strip sourced from
 * the fleet-wide history feed (#580). Complements `AdminAuditTail`
 * (which is a method/path log across every admin write surface);
 * this card is specifically the config-edit audit, which the cashback
 * team reads with higher frequency.
 *
 * Self-hides on loading (spinner) / error / empty so a fresh deploy
 * with no edits yet doesn't render a dead card. Each row links to the
 * per-merchant page so the admin can drill down from the summary.
 *
 * Staleness is short (30s) — this is the "what just changed" card
 * and ops expects it to pick up edits without a hard reload.
 */
export function ConfigsHistoryCard(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-configs-history', LIMIT],
    queryFn: () => getAdminConfigsHistory({ limit: LIMIT }),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }

  if (query.isError) return null;

  const rows = query.data.history;
  if (rows.length === 0) return null;

  return (
    <section
      aria-labelledby="configs-history-heading"
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2
          id="configs-history-heading"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          Recent config changes
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Last {LIMIT} cashback-config edits across every merchant (ADR 011 / #580). Click a row to
          drill into that merchant&rsquo;s history.
        </p>
      </header>
      <ul role="list" className="divide-y divide-gray-100 dark:divide-gray-900">
        {rows.map((row) => (
          <ConfigHistoryRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function ConfigHistoryRow({ row }: { row: AdminConfigHistoryEntry }): React.JSX.Element {
  return (
    <li>
      <Link
        to={`/admin/cashback#${encodeURIComponent(row.merchantId)}`}
        className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-gray-900 dark:text-white">
            {row.merchantName}
          </div>
          <div className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {row.wholesalePct}% wholesale · {row.userCashbackPct}% cashback · {row.loopMarginPct}%
            margin{row.active ? '' : ' · inactive'}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
          <div className="tabular-nums">{fmtRelative(row.changedAt)}</div>
          <div className="truncate" title={row.changedBy}>
            by {truncId(row.changedBy)}
          </div>
        </div>
      </Link>
    </li>
  );
}

/**
 * Short "2m ago" style timestamp. Falls back to the input string on
 * parse failure so a malformed ISO doesn't tear the row down.
 */
export function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Admin actor ids are uuids — short-form is plenty for the strip. */
export function truncId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}…`;
}
