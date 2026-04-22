/**
 * `/admin/audit` — full admin write-audit trail (ADR 017 / 018).
 *
 * The "Recent admin activity" card on `/admin` tails the same
 * store but caps at 100 rows. One active afternoon of credit
 * adjustments + payout retries + merchant-config edits can
 * exceed that easily, so this page pages older rows via the
 * endpoint's `?before=<iso>` cursor.
 *
 * Every page of 50 rows gets its own TanStack query (cursor in
 * the key), so re-entering the tab restores the accumulated
 * pages from cache instead of re-scrolling.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.audit';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getAdminAuditTail, type AdminAuditTailRow } from '~/services/admin';
import { auditRowLink, fmtRelative } from '~/components/features/admin/AdminAuditTail';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Audit — Loop' }];
}

const PAGE_SIZE = 50;

function statusColor(status: number): string {
  if (status >= 200 && status < 300) {
    return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
  }
  if (status >= 400 && status < 500) {
    return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
  }
  return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
}

export default function AdminAuditRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  // Each Load-more push the last row's createdAt — cursor key means
  // TanStack caches each page independently and re-visiting the tab
  // restores the accumulated view instead of collapsing to page 1.
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  if (!isAuthenticated) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-12">
        <AdminNav />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · Audit</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with an admin account.</p>
        <Button onClick={() => void navigate('/auth')}>Sign in</Button>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Audit</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Every admin write, newest first, from the ADR-017{' '}
            <code className="font-mono">admin_idempotency_keys</code> store. Same rows as the
            Discord audit channel — this is the durable mirror.
          </p>
        </div>
        {/* Finance / legal CSV export — ops hands this to SOC-2 auditors
            or packages it into a compliance report. Default window is
            the last 31 days; the filename carries the since-date so
            multiple exports don't overwrite each other. */}
        <CsvDownloadButton
          path="/api/admin/audit-tail.csv"
          filename={`admin-audit-${new Date().toISOString().slice(0, 10)}.csv`}
        />
      </header>

      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {cursors.map((cursor, idx) => (
          <AuditPage
            key={cursor ?? 'head'}
            cursor={cursor}
            isLastPage={idx === cursors.length - 1}
            onLoadMore={(nextCursor) => {
              setCursors((prev) => [...prev, nextCursor]);
            }}
          />
        ))}
      </section>
    </main>
  );
}

function AuditPage({
  cursor,
  isLastPage,
  onLoadMore,
}: {
  cursor: string | undefined;
  isLastPage: boolean;
  onLoadMore: (nextCursor: string) => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-audit', cursor ?? null, PAGE_SIZE],
    queryFn: () =>
      getAdminAuditTail({
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { before: cursor } : {}),
      }),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    const denied =
      query.error instanceof ApiException &&
      (query.error.status === 401 || query.error.status === 404);
    return (
      <p className="px-6 py-4 text-sm text-red-600 dark:text-red-400">
        {denied ? 'Only admins can view the audit trail.' : 'Failed to load audit rows.'}
      </p>
    );
  }

  const rows = query.data.rows;
  if (rows.length === 0 && cursor === undefined) {
    return (
      <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
        No admin writes recorded yet.
      </p>
    );
  }

  const hasMore = rows.length === PAGE_SIZE;
  const lastCreatedAt = rows[rows.length - 1]?.createdAt;

  return (
    <>
      <ul role="list" className="divide-y divide-gray-100 dark:divide-gray-900">
        {rows.map((row: AdminAuditTailRow) => (
          <li
            key={`${row.actorUserId}-${row.createdAt}`}
            className="flex items-center gap-4 px-6 py-3 text-sm"
          >
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${statusColor(row.status)}`}
              aria-label={`Status ${row.status}`}
            >
              {row.status}
            </span>
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {row.method}
            </span>
            {(() => {
              const to = auditRowLink(row.method, row.path);
              return to !== null ? (
                <Link
                  to={to}
                  className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400 flex-1 truncate"
                  title={row.path}
                >
                  {row.path}
                </Link>
              ) : (
                <span
                  className="font-mono text-xs text-gray-700 dark:text-gray-300 flex-1 truncate"
                  title={row.path}
                >
                  {row.path}
                </span>
              );
            })()}
            <span className="text-xs text-gray-600 dark:text-gray-400 truncate max-w-[14rem]">
              {row.actorEmail}
            </span>
            <span
              title={row.createdAt}
              className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap"
            >
              {fmtRelative(row.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      {isLastPage && hasMore && lastCreatedAt !== undefined ? (
        <div className="px-5 py-4 flex justify-center border-t border-gray-200 dark:border-gray-800">
          <Button
            variant="secondary"
            onClick={() => {
              onLoadMore(lastCreatedAt);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
