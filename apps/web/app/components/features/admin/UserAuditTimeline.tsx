import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAdminUserAuditTimeline, type AdminAuditTimelineEvent } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

// Money-review finding: this MUST match the backend's own default
// (`DEFAULT_PER_SOURCE_LIMIT` in `admin/user-audit-timeline.ts`) —
// that's the value the CF-10 bulk-read-tripwire safety margin is
// computed against (5 sources × 8 + 1 OTP-lock snapshot = 41,
// comfortably under the global 50-row threshold). A higher default
// here would silently blow past that margin on every page load for
// any moderately active user, re-tripping the exact
// "routine-triage-page-trips-the-tripwire" bug this PR fixes for
// `/api/admin/ledger`.
const PER_SOURCE_LIMIT = 8;

const KIND_LABEL: Record<AdminAuditTimelineEvent['kind'], string> = {
  admin_action: 'Admin action',
  ledger: 'Ledger',
  order: 'Order',
  payout: 'Payout',
  session_revoked: 'Session',
  auth_lock: 'OTP lock',
};

const KIND_CLASS: Record<AdminAuditTimelineEvent['kind'], string> = {
  admin_action: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  ledger: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  order: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  payout: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
  session_revoked: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  auth_lock: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
};

function drillHref(event: AdminAuditTimelineEvent): string | null {
  if (event.refType === 'order' && event.refId !== null) return `/admin/orders/${event.refId}`;
  if (event.refType === 'payout' && event.refId !== null) return `/admin/payouts/${event.refId}`;
  return null;
}

interface Props {
  userId: string;
}

/**
 * Per-subject audit timeline (ADR 037 §4 / A5-7) — the merged,
 * newest-first "what happened to this account" view on
 * `/admin/users/:userId`: admin actions targeting this user, ledger
 * movements, orders, payouts, and session revocations, each drill-
 * linking to its own detail page.
 *
 * `?limit=` bounds EACH backend source independently (not the total
 * row count returned) — see `admin/user-audit-timeline.ts` for why.
 * "Older" re-queries with `?before=` set to the oldest event
 * currently shown; because up to five independently-cursored sources
 * are merged, this is an approximate walk (good enough for support
 * triage), not a gapless paginator — documented on the backend.
 */
export function UserAuditTimeline({ userId }: Props): React.JSX.Element {
  const [beforeCursor, setBeforeCursor] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['admin-user-audit-timeline', userId, beforeCursor],
    queryFn: () =>
      getAdminUserAuditTimeline(userId, {
        limit: PER_SOURCE_LIMIT,
        ...(beforeCursor !== null ? { before: beforeCursor } : {}),
      }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const events = query.data?.events ?? [];

  const pageOlder = (): void => {
    const last = events[events.length - 1];
    if (last === undefined) return;
    setBeforeCursor(last.at);
  };

  const pageToTop = (): void => setBeforeCursor(null);

  return (
    <div className="space-y-4">
      {query.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="py-6 text-sm text-red-600 dark:text-red-400">
          Failed to load the audit timeline.
        </p>
      ) : events.length === 0 ? (
        <p className="py-6 text-sm text-gray-500 dark:text-gray-400">
          {beforeCursor === null
            ? 'No admin actions, money movements, or session events for this user yet.'
            : 'No older activity.'}
        </p>
      ) : (
        <ol className="space-y-2">
          {events.map((event, i) => {
            const href = drillHref(event);
            return (
              <li
                key={`${event.kind}-${event.at}-${i}`}
                className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
              >
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${KIND_CLASS[event.kind]}`}
                >
                  {KIND_LABEL[event.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-gray-900 dark:text-white">
                    {href !== null ? (
                      <Link to={href} className="text-blue-600 hover:underline dark:text-blue-400">
                        {event.summary}
                      </Link>
                    ) : (
                      event.summary
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(event.at).toLocaleString(ADMIN_LOCALE, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <nav className="flex justify-between" aria-label="Audit timeline pagination">
        <button
          type="button"
          onClick={pageToTop}
          disabled={beforeCursor === null}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          ← Newest
        </button>
        <button
          type="button"
          onClick={pageOlder}
          disabled={events.length === 0}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Older →
        </button>
      </nav>
    </div>
  );
}
