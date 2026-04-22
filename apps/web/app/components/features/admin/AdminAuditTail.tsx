import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAdminAuditTail, type AdminAuditTailRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const DEFAULT_LIMIT = 25;
const EXPANDED_LIMIT = 100;

/**
 * Resolves the in-app route an admin-write endpoint affected. Null
 * when the path doesn't match a known resource pattern — the audit
 * row then renders the path as plain text. The value is intentionally
 * scoped: we only link to pages ops has elsewhere — guessing a
 * route from an unknown admin-write would silently 404.
 */
export function auditRowLink(method: string, path: string): string | null {
  // /api/admin/users/:userId/credit-adjustments (POST)
  const credit = /^\/api\/admin\/users\/([0-9a-f-]{36})\/credit-adjustments$/i.exec(path);
  if (credit !== null && method === 'POST') return `/admin/users/${credit[1]}`;
  // /api/admin/payouts/:id/retry (POST)
  const retry = /^\/api\/admin\/payouts\/([0-9a-f-]{36})\/retry$/i.exec(path);
  if (retry !== null && method === 'POST') return `/admin/payouts/${retry[1]}`;
  // /api/admin/merchant-cashback-configs/:merchantId (PUT)
  const cfg = /^\/api\/admin\/merchant-cashback-configs\/([^/]+)$/.exec(path);
  if (cfg !== null && method === 'PUT') return '/admin/cashback';
  return null;
}

/**
 * Formats an audit row's `createdAt` as a short relative-time string
 * ("3m ago", "2h ago", "2d ago"). Audit rows care about "how recent",
 * not exact time — hover/title attribute carries the ISO string for
 * ops who want precision.
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

function statusColor(status: number): string {
  if (status >= 200 && status < 300) {
    return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
  }
  if (status >= 400 && status < 500) {
    return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
  }
  return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
}

/**
 * "Recent admin activity" card for /admin. Tails the ADR 017/018
 * audit store so ops can see every mutation without scrolling
 * the Discord channel or tailing server logs.
 */
export function AdminAuditTail(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? EXPANDED_LIMIT : DEFAULT_LIMIT;
  const query = useQuery({
    queryKey: ['admin-audit-tail', limit],
    queryFn: () => getAdminAuditTail(limit),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Recent admin activity
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Newest first, from the ADR 017 <code className="font-mono">admin_idempotency_keys</code>{' '}
          store (same rows as the Discord audit channel).
        </p>
      </header>

      {query.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="px-6 py-4 text-sm text-red-600 dark:text-red-400">
          Failed to load the audit tail.
        </p>
      ) : query.data.rows.length === 0 ? (
        <p className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">No admin writes yet.</p>
      ) : (
        <ul role="list" className="divide-y divide-gray-100 dark:divide-gray-900">
          {query.data.rows.map((row: AdminAuditTailRow) => (
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
                  <span className="font-mono text-xs text-gray-700 dark:text-gray-300 flex-1 truncate">
                    {row.path}
                  </span>
                );
              })()}
              <span className="text-xs text-gray-600 dark:text-gray-400 truncate max-w-[12rem]">
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
      )}

      {/* Show/collapse toggle — the default 25-row view keeps the
          landing dense; expanding hits the endpoint's ?limit=100
          cap so a day's worth of writes is usually reachable
          without leaving the dashboard. */}
      {!query.isPending && !query.isError && query.data.rows.length >= DEFAULT_LIMIT ? (
        <footer className="border-t border-gray-200 dark:border-gray-800 px-6 py-2 text-right">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            aria-expanded={expanded}
          >
            {expanded ? 'Collapse' : `Show ${EXPANDED_LIMIT}`}
          </button>
        </footer>
      ) : null}
    </section>
  );
}
