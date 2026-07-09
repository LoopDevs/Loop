import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException, type AdminOrderRedriveResult } from '@loop/shared';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { useStaffRole } from '~/hooks/use-staff-role';
import { generateIdempotencyKey, redriveOrder } from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { ReasonDialog } from './ReasonDialog';
import { StepUpModal } from './StepUpModal';

const REDRIVABLE_STATES = new Set(['paid', 'procuring']);

/**
 * Order re-drive panel (A5-1 — readiness-backlog §Tier 5 "the biggest
 * hole"). A `paid`/`procuring` order with no live worker touching it
 * had NO operator action before this: no requeue, no manual
 * re-procure. `POST /api/admin/orders/:orderId/redrive` re-runs the
 * SAME procurement path the worker itself uses.
 *
 * Admin-tier + step-up (unlike the sibling `OrderDeliveryPanel`,
 * which is support-allowed) — a redrive can submit a real outbound
 * Stellar payment to CTX, so it's a money write per the ADR 037
 * matrix, not a delivery-unsticking read-drive.
 *
 * Self-hides for non-admin staff and for orders outside the
 * `paid`/`procuring` window (nothing to redrive). The backend's own
 * guards are the source of truth on WHETHER a specific redrive
 * attempt is safe right now (staleness / already-paid-CTX / state
 * raced) — this panel surfaces those as errors rather than
 * pre-computing eligibility client-side.
 */
export function OrderRedrivePanel({
  orderId,
  orderState,
}: {
  orderId: string;
  orderState: string;
}): React.JSX.Element | null {
  const { isAdminRole } = useStaffRole();
  const queryClient = useQueryClient();
  const addToast = useUiStore((s) => s.addToast);
  const [last, setLast] = useState<AdminOrderRedriveResult | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);

  const stepUp = useAdminStepUp();
  const redrive = useMutation({
    mutationFn: (args: { reason: string; idempotencyKey: string }) =>
      stepUp.runWithStepUp(() => redriveOrder({ orderId, ...args })),
    onSuccess: (envelope) => {
      const res = envelope.result;
      setLast(res);
      void queryClient.invalidateQueries({ queryKey: ['admin-order', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-order-payout', orderId] });
      if (res.outcome === 'fulfilled') {
        addToast('Order redriven — fulfilled.', 'success');
      } else if (res.outcome === 'skipped') {
        addToast(
          `Redrive skipped — the order is already being handled (now '${res.state}'). Refresh to see the live state.`,
          'success',
        );
      } else {
        addToast(`Redrive ran but the order failed again (now '${res.state}').`, 'error');
      }
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Order redrive failed.', 'error');
    },
  });

  const handleReason = (reason: string | null): void => {
    setReasonOpen(false);
    if (reason !== null) {
      redrive.mutate({ reason, idempotencyKey: generateIdempotencyKey() });
    }
  };

  // Admin-only (money write) and only meaningful for the two
  // redrivable states — the backend re-validates this regardless.
  if (!isAdminRole || !REDRIVABLE_STATES.has(orderState)) return null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <header className="flex items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Re-drive (A5-1)
        </h2>
      </header>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        This order is stuck in <code className="font-mono text-xs">{orderState}</code> with no
        automatic action pending. Re-driving re-runs the same procurement path the worker uses —
        idempotent and audited. A `procuring` order only redrives once it&rsquo;s past the normal
        procurement window; if Loop already paid CTX for it, the redrive refuses rather than create
        a second CTX order.
      </p>
      {last !== null ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {`Last redrive: outcome '${last.outcome}', order now '${last.state}'.`}
        </p>
      ) : null}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setReasonOpen(true)}
          disabled={redrive.isPending}
          className="rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
        >
          {redrive.isPending ? 'Redriving…' : 'Re-drive order'}
        </button>
      </div>

      <ReasonDialog
        open={reasonOpen}
        title="Reason for redriving this order?"
        description="2–500 characters. Logged in the admin audit trail (ADR-017)."
        confirmLabel="Redrive"
        onResolve={handleReason}
      />
    </section>
  );
}
