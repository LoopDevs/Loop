import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { adminLookup } from '~/services/admin';

/**
 * Global admin search box (ADR 037 — User 360 reverse lookups).
 *
 * One input for the four identifiers a support ticket quotes:
 *
 *   - email (contains `@`)      → the existing `/admin/users?q=`
 *     directory search (server-side ILIKE).
 *   - order id / payment memo / Stellar address → `GET
 *     /api/admin/lookup?q=` resolves the owner, then we navigate:
 *       kind=order                            → /admin/orders/:orderId
 *       kind=payment_memo / stellar_address   → /admin/users/:userId
 *       404 NOT_FOUND (well-formed, no match) → inline "no match"
 *       hint (the backend has no `kind: 'none'` sentinel).
 *
 * Renders on the admin home and the user-360 page so "find the
 * customer" never requires knowing which identifier class you're
 * holding. Support-visible: lookups are reads (ADR 037 §3).
 */
export function AdminLookupSearch(): React.JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [noMatch, setNoMatch] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: adminLookup,
    onSuccess: (res) => {
      if (res.kind === 'order' && res.orderId !== undefined) {
        void navigate(`/admin/orders/${encodeURIComponent(res.orderId)}`);
        return;
      }
      // payment_memo / stellar_address — "find the customer" lands on
      // the user 360 (the memo's order is one click away from there).
      void navigate(`/admin/users/${encodeURIComponent(res.userId)}`);
    },
    onError: (err) => {
      if (err instanceof ApiException && err.status === 404) {
        setNoMatch('No order, memo, or address matched that identifier.');
        return;
      }
      setNoMatch(err instanceof ApiException ? err.message : 'Lookup failed.');
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setNoMatch(null);
    const trimmed = q.trim();
    if (trimmed.length === 0) return;
    if (trimmed.includes('@')) {
      // Email → the existing directory search owns email resolution.
      void navigate(`/admin/users?q=${encodeURIComponent(trimmed)}`);
      return;
    }
    lookup.mutate(trimmed);
  };

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      aria-label="Global admin lookup"
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setNoMatch(null);
        }}
        placeholder="Email, order id, payment memo, or Stellar address"
        aria-label="Email, order id, payment memo, or Stellar address"
        className="w-full max-w-md rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />
      <button
        type="submit"
        disabled={lookup.isPending || q.trim().length === 0}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {lookup.isPending ? 'Looking up…' : 'Find'}
      </button>
      {noMatch !== null ? (
        <span role="status" className="text-xs text-gray-500 dark:text-gray-400">
          {noMatch}
        </span>
      ) : null}
    </form>
  );
}
