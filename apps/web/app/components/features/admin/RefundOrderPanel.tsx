import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException, type AdminOrderRefundResult } from '@loop/shared';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { useOnline } from '~/hooks/use-online';
import { useStaffRole } from '~/hooks/use-staff-role';
import { generateIdempotencyKey, refundOrder } from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { Button } from '~/components/ui/Button';
import { Dialog } from '~/components/ui/Dialog';
import { StepUpModal } from './StepUpModal';

/**
 * Order-bound refund panel (A5-4 — readiness-backlog §Tier 5). Surfaces
 * `POST /api/admin/orders/:orderId/refund` as a button on the admin
 * order-detail page. Admin-tier + step-up (self-hides for non-admin
 * staff and for non-refundable order states — the backend re-validates
 * regardless; this gate is a UX filter, not the security boundary).
 *
 * The operator-decided policy (readiness-backlog A5-4, 2026-07-10):
 *   - `paid` / `procuring` / `failed` orders refund directly.
 *   - `fulfilled` orders (the customer already received the gift-card
 *     code) ARE refundable, but ONLY behind a REQUIRED code-unused
 *     attestation — the operator affirms the delivered code is
 *     unused/unusable. This is the accepted compensating control for
 *     the double-spend risk (the user could keep the code AND get
 *     refunded), which stands in for CTX redemption-verification Loop
 *     doesn't have yet. The dialog makes that risk prominent and won't
 *     enable submit until the operator ticks the attestation box.
 *
 * The refund itself reuses the existing refund primitives server-side
 * (on-chain refund-to-sender for xlm/usdc, mirror credit for `credit`,
 * fails closed for `loop_asset`) — this panel is the operator surface,
 * not a new money path.
 */
const REFUNDABLE_STATES = new Set(['paid', 'procuring', 'failed', 'fulfilled']);

const NOTE_MIN = 2;
const NOTE_MAX = 500;

export function RefundOrderPanel({
  orderId,
  orderState,
}: {
  orderId: string;
  orderState: string;
}): React.JSX.Element | null {
  const { isAdminRole } = useStaffRole();
  const queryClient = useQueryClient();
  const addToast = useUiStore((s) => s.addToast);
  // FE-43: a refund is a non-idempotent-feeling money write. Offline the POST
  // can only fail (or, worse, double-submit on a connectivity flap), so gate
  // the entry into the refund dialog on connectivity — matching the
  // PayWithLoopBalance offline-guard pattern.
  const online = useOnline();
  const offlineHintId = useId();
  const [last, setLast] = useState<AdminOrderRefundResult | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const stepUp = useAdminStepUp();
  const refund = useMutation({
    mutationFn: (args: { reason: string; attestationNote?: string; idempotencyKey: string }) =>
      stepUp.runWithStepUp(
        () =>
          refundOrder({
            orderId,
            reason: args.reason,
            ...(args.attestationNote !== undefined
              ? {
                  attestation: { codeUnused: true as const, attestationNote: args.attestationNote },
                }
              : {}),
            idempotencyKey: args.idempotencyKey,
          }),
        // P2-07: echo which order the OTP refunds. The refund amount is
        // the full order charge, computed server-side, so the order id is
        // the identifying detail available on the client.
        { action: 'Refund order', scope: 'order-refund', destination: orderId },
      ),
    onSuccess: (envelope) => {
      const res = envelope.result;
      setLast(res);
      void queryClient.invalidateQueries({ queryKey: ['admin-order', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-order-payout', orderId] });
      const how =
        res.refundMethod === 'onchain_deposit_refund'
          ? 'refunded on-chain to the sender'
          : 'refunded to the Loop credit balance';
      addToast(`Order ${how}.`, 'success');
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Order refund failed.', 'error');
    },
  });

  const isFulfilled = orderState === 'fulfilled';

  const handleSubmit = (reason: string, attestationNote?: string): void => {
    setDialogOpen(false);
    refund.mutate({
      reason,
      ...(attestationNote !== undefined ? { attestationNote } : {}),
      idempotencyKey: generateIdempotencyKey(),
    });
  };

  // Admin-only (money write) and only meaningful for a refundable order.
  // pending_payment (nothing collected) / expired self-hide.
  if (!isAdminRole || !REFUNDABLE_STATES.has(orderState)) return null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <header className="flex items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Refund order (A5-4)
        </h2>
      </header>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Refunds the full order charge, reusing the existing refund path for the order&rsquo;s
        payment method (on-chain refund-to-sender for XLM/USDC, Loop credit balance for a
        credit-funded order). Order-bound, idempotent, and audited (ADR-017).
      </p>
      {last !== null ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {`Last refund: ${last.refundMethod === 'onchain_deposit_refund' ? 'on-chain to sender' : 'mirror credit'}, order now '${last.orderState}'${last.attested ? ' (fulfilled — attestation confirmed)' : ''}.`}
        </p>
      ) : null}
      <div className="mt-3">
        <Button
          type="button"
          variant="destructive"
          onClick={() => setDialogOpen(true)}
          disabled={refund.isPending || !online}
          aria-describedby={!online ? offlineHintId : undefined}
        >
          {refund.isPending ? 'Refunding…' : 'Refund order'}
        </Button>
        {!online && (
          <p id={offlineHintId} className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            You’re offline — reconnect to refund this order.
          </p>
        )}
      </div>

      <RefundDialog
        open={dialogOpen}
        isFulfilled={isFulfilled}
        onCancel={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
      />
    </section>
  );
}

/**
 * Refund dialog — reason always, plus (for a FULFILLED order) a
 * prominent double-spend warning + a REQUIRED "code is unused/unusable"
 * attestation checkbox and note. Submit stays disabled on a fulfilled
 * order until the checkbox is ticked and the note is 2-500 chars.
 * FE-33: the native `<dialog>` shell (focus-trap / ESC / aria-modal)
 * comes from the shared `Dialog` primitive (`size="lg"`).
 */
function RefundDialog({
  open,
  isFulfilled,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  isFulfilled: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, attestationNote?: string) => void;
}): React.JSX.Element {
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const [reason, setReason] = useState('');
  const [codeUnused, setCodeUnused] = useState(false);
  const [attestationNote, setAttestationNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  // Reset all fields on each reopen. `Dialog` calls this on the
  // closed→open transition, before it focuses the reason textarea.
  const resetOnOpen = (): void => {
    setReason('');
    setCodeUnused(false);
    setAttestationNote('');
    setError(null);
  };

  const reasonValid = reason.trim().length >= NOTE_MIN && reason.trim().length <= NOTE_MAX;
  const noteValid =
    attestationNote.trim().length >= NOTE_MIN && attestationNote.trim().length <= NOTE_MAX;
  // A fulfilled-order refund additionally needs the ticked attestation
  // AND a valid note; a pre-fulfilment refund needs only the reason.
  const canSubmit = reasonValid && (!isFulfilled || (codeUnused && noteValid));

  const submit = (): void => {
    if (!reasonValid) {
      setError(`Reason must be ${NOTE_MIN}–${NOTE_MAX} characters`);
      return;
    }
    if (isFulfilled) {
      if (!codeUnused) {
        setError(
          'You must confirm the delivered code is unused/unusable to refund a fulfilled order',
        );
        return;
      }
      if (!noteValid) {
        setError(`Attestation note must be ${NOTE_MIN}–${NOTE_MAX} characters`);
        return;
      }
      onSubmit(reason.trim(), attestationNote.trim());
      return;
    }
    onSubmit(reason.trim());
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      onOpen={resetOnOpen}
      initialFocusRef={reasonRef}
      size="lg"
      labelledBy={`${ids}-title`}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3 p-5"
      >
        <h2 id={`${ids}-title`} className="text-base font-semibold">
          Refund this order?
        </h2>

        {isFulfilled ? (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          >
            <p className="font-semibold">This order is fulfilled.</p>
            <p className="mt-1">
              The customer may have already used the delivered gift-card code — Loop cannot verify
              redemption with CTX. Refunding a used code loses the money twice. Only refund if you
              have confirmed the code is unused/unusable.
            </p>
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-700 dark:text-gray-300">
            Reason ({NOTE_MIN}–{NOTE_MAX} chars, logged in the admin audit trail)
          </span>
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error !== null) setError(null);
            }}
            minLength={NOTE_MIN}
            maxLength={NOTE_MAX}
            rows={2}
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        {isFulfilled ? (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={codeUnused}
                onChange={(e) => {
                  setCodeUnused(e.target.checked);
                  if (error !== null) setError(null);
                }}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="font-medium text-gray-800 dark:text-gray-200">
                I confirm the delivered gift-card code is unused/unusable.
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-gray-700 dark:text-gray-300">
                Attestation note ({NOTE_MIN}–{NOTE_MAX} chars — how you know the code is unused)
              </span>
              <textarea
                value={attestationNote}
                onChange={(e) => {
                  setAttestationNote(e.target.value);
                  if (error !== null) setError(null);
                }}
                minLength={NOTE_MIN}
                maxLength={NOTE_MAX}
                rows={2}
                disabled={!codeUnused}
                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
            </label>
          </>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!canSubmit}>
            Refund
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
