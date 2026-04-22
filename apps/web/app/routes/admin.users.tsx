import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.users';
import { useAuth } from '~/hooks/use-auth';
import {
  listAdminUsers,
  getAdminUserByEmail,
  type AdminUserRow,
  type AdminUserDetail,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { TopUsersTable } from '~/components/features/admin/TopUsersTable';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Users — Loop' }];
}

const PAGE_SIZE = 25;

function truncId(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * `/admin/users` — admin directory / search surface. The endpoint
 * returns `created_at DESC` so the top of the list is always the
 * newest signups; `?before=<iso>` pages to older rows. A server-side
 * ILIKE on email powers the search input (backend escapes LIKE
 * metacharacters so `foo_bar` doesn't secretly match `foo?bar`).
 *
 * Click a row → detail view (`/admin/users/:id`) ships in a follow-up
 * slice along with the drill-down endpoint's credit-adjustment UI.
 */
export default function AdminUsersRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const before = searchParams.get('before') ?? undefined;
  const [qDraft, setQDraft] = useState(q);
  const [emailDraft, setEmailDraft] = useState('');
  const [byEmailError, setByEmailError] = useState<string | null>(null);
  const byEmailMutation = useMutation<AdminUserDetail, unknown, string>({
    mutationFn: (email: string) => getAdminUserByEmail(email),
    onSuccess: (user) => {
      setByEmailError(null);
      void navigate(`/admin/users/${user.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiException && err.status === 404) {
        setByEmailError('No user with that email.');
        return;
      }
      setByEmailError(err instanceof ApiException ? err.message : 'Lookup failed.');
    },
  });

  const query = useQuery({
    queryKey: ['admin-users', q, before ?? null],
    queryFn: () =>
      listAdminUsers({
        ...(q.length > 0 ? { q } : {}),
        ...(before !== undefined ? { before } : {}),
        limit: PAGE_SIZE,
      }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const applySearch = (): void => {
    setSearchParams((params) => {
      const trimmed = qDraft.trim();
      if (trimmed.length === 0) params.delete('q');
      else params.set('q', trimmed);
      params.delete('before');
      return params;
    });
  };

  const clearSearch = (): void => {
    setQDraft('');
    setSearchParams((params) => {
      params.delete('q');
      params.delete('before');
      return params;
    });
  };

  const pageOlder = (): void => {
    const last = query.data?.users[query.data.users.length - 1];
    if (last === undefined) return;
    setSearchParams((params) => {
      params.set('before', last.createdAt);
      return params;
    });
  };

  const pageToTop = (): void => {
    setSearchParams((params) => {
      params.delete('before');
      return params;
    });
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · Users</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with an admin account.</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Go to sign-in
        </button>
      </main>
    );
  }

  const rows = query.data?.users ?? [];
  const hasMore = rows.length === PAGE_SIZE;

  return (
    <main className="max-w-6xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Users</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Paginated user directory. The fragment search below is a case-insensitive contains match;
          the <em>Find by exact email</em> input above is a direct jump when you have the full
          address from a support ticket.
        </p>
      </header>

      {/* Exact-match by-email lookup. Distinct from the fragment search
          below — this one takes the full address and navigates straight
          to the detail page on hit. Backend normalises to lowercase, so
          pasting mixed-case from a ticket doesn't miss the row. */}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = emailDraft.trim();
          if (trimmed.length === 0 || byEmailMutation.isPending) return;
          setByEmailError(null);
          byEmailMutation.mutate(trimmed);
        }}
      >
        <input
          type="email"
          value={emailDraft}
          onChange={(e) => setEmailDraft(e.target.value)}
          placeholder="Find by exact email (e.g. alice@example.com)"
          aria-label="Find user by exact email"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-[280px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
        />
        <button
          type="submit"
          disabled={emailDraft.trim().length === 0 || byEmailMutation.isPending}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {byEmailMutation.isPending ? 'Looking up…' : 'Find by email'}
        </button>
      </form>
      {byEmailError !== null ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 -mt-3">
          {byEmailError}
        </p>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applySearch();
        }}
      >
        <input
          type="search"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Search by email fragment…"
          aria-label="Search users by email"
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
        />
        <button
          type="submit"
          className="rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
        >
          Search
        </button>
        {q.length > 0 ? (
          <button
            type="button"
            onClick={clearSearch}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Clear
          </button>
        ) : null}
      </form>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load users. You may not be an admin.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-6">
          {q.length > 0 ? `No users matching "${q}".` : 'No users found.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['Signed up', 'Email', 'Home', 'Role', 'ID'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {rows.map((u: AdminUserRow) => (
                <tr key={u.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    {new Date(u.createdAt).toLocaleString('en-US', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="hover:underline text-blue-600 dark:text-blue-400"
                    >
                      {u.email}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{u.homeCurrency}</td>
                  <td className="px-3 py-2">
                    {u.isAdmin ? (
                      <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                        admin
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 dark:text-gray-400">user</span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400"
                    title={u.id}
                  >
                    {truncId(u.id)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex justify-between" aria-label="Pagination">
        <button
          type="button"
          onClick={pageToTop}
          disabled={before === undefined}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          ← Newest
        </button>
        <button
          type="button"
          onClick={pageOlder}
          disabled={!hasMore}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Older →
        </button>
      </nav>

      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Top earners (30d)
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Ranked by cashback-type credit_transactions accrued in the last 30 days (ADR 009/015).
            Useful for both recognition and concentration-risk — a single user accounting for a
            large share is worth a closer look.
          </p>
        </header>
        <div className="px-6 py-5">
          <TopUsersTable />
        </div>
      </section>
    </main>
  );
}
