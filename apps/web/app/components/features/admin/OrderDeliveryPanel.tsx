import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiException, type AdminRefetchRedemptionResult } from '@loop/shared';
import { refetchOrderRedemption } from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';

/**
 * Order delivery panel (ADR 037 §3 — view 3).
 *
 * The fulfilled-null gap: an order can reach `fulfilled` with the
 * CTX redemption material (redeem URL / code / PIN) still missing —
 * either a CTX-side delay or a swallowed fetch error. This panel
 * gives support the re-drive: `POST
 * /api/admin/orders/:orderId/refetch-redemption` re-runs the fetch
 * and reports whether redemption material is now present.
 *
 * Redemption status is sourced from the refetch result — the admin
 * order read doesn't expose redemption material (deliberately: it's
 * the gift card's cash value, and the never-render rule for admin
 * eyes is part of the delivery-integrity story). Until the button is
 * pressed the status reads "not checked". Backfill attempts are not
 * exposed by the current contract, so none are rendered.
 *
 * Support-allowed (idempotent re-drive of work the customer already
 * paid for — ADR 037 §3), so it renders for both staff roles.
 */
export function OrderDeliveryPanel({
  orderId,
  orderState,
}: {
  orderId: string;
  orderState: string;
}): React.JSX.Element | null {
  const addToast = useUiStore((s) => s.addToast);
  const [last, setLast] = useState<AdminRefetchRedemptionResult | null>(null);

  const refetch = useMutation({
    mutationFn: () => refetchOrderRedemption(orderId),
    onSuccess: (res) => {
      setLast(res);
      if (res.redemptionPresent) {
        addToast(
          res.refetched
            ? 'Redemption material fetched — the customer can redeem now.'
            : 'Redemption material was already present — nothing to refetch.',
          'success',
        );
      } else {
        addToast(
          'Redemption is still missing after the refetch — likely a CTX-side delay. Try again later or escalate.',
          'error',
        );
      }
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Redemption refetch failed.', 'error');
    },
  });

  // The redemption fetch only applies once CTX fulfilled the order —
  // earlier states have nothing to refetch, so the panel self-hides.
  if (orderState !== 'fulfilled') return null;

  const statusLabel =
    last === null ? 'not checked' : last.redemptionPresent ? 'present' : 'missing';
  const statusClasses =
    last === null
      ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      : last.redemptionPresent
        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Delivery / redemption
        </h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClasses}`}>
          redemption {statusLabel}
        </span>
      </header>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        A fulfilled order can still be missing its redeem URL / code / PIN (CTX-side delay or a
        dropped fetch). Re-run the redemption fetch to unstick delivery — idempotent and audited;
        the material itself is never shown here.
      </p>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => refetch.mutate()}
          disabled={refetch.isPending}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {refetch.isPending ? 'Refetching…' : 'Refetch redemption'}
        </button>
      </div>
    </section>
  );
}
