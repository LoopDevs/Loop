import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  resyncMerchants,
  type AdminMerchantResyncResponse,
  type AdminWriteEnvelope,
} from '~/services/admin';

/**
 * Force-refresh the merchant catalog from upstream CTX (ADR 011).
 *
 * Rendered on /admin/cashback next to the page title — the natural
 * home because the merchant catalog is what that page edits. Click
 * handling:
 *
 * - 200 + `triggered: true`  → flash "Synced N merchants" for 3s.
 * - 200 + `triggered: false` → flash "Already in sync" (another
 *   admin clicked the button in the same 30s window; both see the
 *   same post-sync snapshot).
 * - 502 UPSTREAM_ERROR       → red inline error; cached snapshot
 *   is retained so other pages keep working.
 * - 429                      → rate-limit-exceeded message; the
 *   endpoint caps at 2/min per IP because every hit reaches CTX.
 *
 * Invalidates `['admin-merchant-stats']` + the public merchant
 * query cache so the rest of the page re-renders against the
 * new catalog without a hard reload.
 */
export function MerchantResyncButton(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<AdminWriteEnvelope<AdminMerchantResyncResponse>, Error, string>({
    mutationFn: (reason: string) => resyncMerchants({ reason }),
    onSuccess: ({ result }) => {
      setError(null);
      const label = result.triggered
        ? `Synced ${result.merchantCount.toLocaleString('en-US')} merchants`
        : 'Already in sync';
      setFlash(label);
      setTimeout(() => setFlash(null), 3000);
      void queryClient.invalidateQueries({ queryKey: ['merchants'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-merchant-stats'] });
    },
    onError: (err) => {
      setFlash(null);
      if (err instanceof ApiException && err.status === 429) {
        setError('Too many resyncs — try again in a minute.');
        return;
      }
      if (err instanceof ApiException && err.status === 502) {
        setError('Upstream CTX refused the sweep. Previous catalog is still live.');
        return;
      }
      setError(err instanceof ApiException ? err.message : 'Resync failed.');
    },
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => {
          setError(null);
          // A2-509: ADR-017 requires a reason on every admin mutation.
          // Same prompt-based pattern as retry-payout and the cashback
          // split editor — a11y/UX upgrade tracked under A2-1107.
          const reason = window.prompt('Reason for forcing a catalog resync:', '');
          if (reason === null) return;
          const trimmed = reason.trim();
          if (trimmed.length < 2 || trimmed.length > 500) {
            setError('Reason must be 2–500 characters');
            return;
          }
          mutation.mutate(trimmed);
        }}
        disabled={mutation.isPending}
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {mutation.isPending ? 'Resyncing…' : 'Resync catalog'}
      </button>
      {flash !== null ? (
        <span role="status" className="text-xs text-green-700 dark:text-green-400">
          {flash}
        </span>
      ) : null}
      {error !== null ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
