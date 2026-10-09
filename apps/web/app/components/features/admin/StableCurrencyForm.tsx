import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ApiException,
  HOME_CURRENCIES,
  displayCurrencyCode,
  fiatForHeldStable,
  heldStableForCurrency,
  type HomeCurrency,
} from '@loop/shared';
import {
  generateIdempotencyKey,
  setUserStableCurrency,
  type AdminWriteEnvelope,
  type StableCurrencySetResult,
} from '~/services/admin';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { ReplayedBadge } from './ReplayedBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { StepUpModal } from './StepUpModal';

interface Props {
  userId: string;
  /** The user's current CTX stable (may be ''), used to seed the dropdown and detect no-ops client-side. */
  currentStableCurrency: string;
}

function displayStable(stableCurrency: string): string {
  return stableCurrency === '' ? '—' : displayCurrencyCode(stableCurrency);
}

/**
 * Admin stable-currency change form. Same shape as
 * `CreditAdjustmentForm` / `AdminEmissionForm`: confirm-dialog
 * gate before submit, step-up auth dance via `useAdminStepUp`,
 * `audit.replayed` badge after submit. Backend enforces the safety
 * preflight (no live balance / no in-flight payouts) and surfaces
 * the failure as a 409 with a witness in the message — we render
 * that verbatim rather than re-implementing the rule client-side.
 */
export function StableCurrencyForm({ userId, currentStableCurrency }: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const currentFiat = fiatForHeldStable(currentStableCurrency);
  const [target, setTarget] = useState<HomeCurrency>(currentFiat ?? 'USD');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<{
    result: StableCurrencySetResult;
    replayed: boolean;
  } | null>(null);
  const [pendingPayload, setPendingPayload] = useState<{
    stableCurrency: string;
    reason: string;
    // CF-09: minted once at confirm time, reused on the step-up retry.
    idempotencyKey: string;
  } | null>(null);

  const stepUp = useAdminStepUp();

  const mutation = useMutation({
    mutationFn: (args: Parameters<typeof setUserStableCurrency>[0]) =>
      // P2-07: not a money movement, but still echo what the OTP
      // authorizes (target currency) rather than a blank confirmation.
      stepUp.runWithStepUp(() => setUserStableCurrency(args), {
        action: `Change stable currency to ${displayStable(args.stableCurrency)}`,
        scope: 'stable-currency',
      }),
    onSuccess: (envelope: AdminWriteEnvelope<StableCurrencySetResult>) => {
      setLastApplied({ result: envelope.result, replayed: envelope.audit.replayed });
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-user', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-user-credits', userId] });
    },
    onError: (err) => {
      if (err instanceof ApiException) {
        setFormError(err.message);
      } else if (err instanceof Error) {
        setFormError(err.message);
      } else {
        setFormError('Stable currency change failed');
      }
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setFormError(null);
    setLastApplied(null);

    const trimmedReason = reason.trim();
    if (trimmedReason.length < 2 || trimmedReason.length > 500) {
      setFormError('Reason must be 2–500 characters.');
      return;
    }
    const stableCurrency = heldStableForCurrency(target);
    if (stableCurrency === currentStableCurrency) {
      setFormError(`User is already on ${target}.`);
      return;
    }

    setPendingPayload({
      stableCurrency,
      reason: trimmedReason,
      idempotencyKey: generateIdempotencyKey(),
    });
  };

  const handleConfirm = (confirmed: boolean): void => {
    const payload = pendingPayload;
    setPendingPayload(null);
    if (!confirmed || payload === null) return;
    mutation.mutate({
      userId,
      stableCurrency: payload.stableCurrency,
      reason: payload.reason,
      idempotencyKey: payload.idempotencyKey,
    });
  };

  const dialogBody =
    pendingPayload !== null ? (
      <div className="space-y-2">
        <p>
          Switch user&rsquo;s stable currency from{' '}
          <strong>{displayStable(currentStableCurrency)}</strong> to{' '}
          <strong>{displayStable(pendingPayload.stableCurrency)}</strong>?
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          CTX rejects the change unless the user&rsquo;s wallet and savings are empty. This action
          is logged in the audit trail and fires a Discord notification.
        </p>
      </div>
    ) : null;

  return (
    <form className="space-y-4" onSubmit={handleSubmit} aria-labelledby="stable-currency-heading">
      <p id="stable-currency-heading" className="sr-only">
        Change stable currency
      </p>
      <ConfirmDialog
        open={pendingPayload !== null}
        title="Confirm stable currency change"
        body={dialogBody}
        confirmLabel="Change stable currency"
        onResolve={handleConfirm}
      />
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1 sm:col-span-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            New stable currency
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as HomeCurrency)}
            aria-label="New stable currency"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            {HOME_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === currentFiat ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2 flex items-end">
          <button
            type="submit"
            disabled={mutation.isPending || heldStableForCurrency(target) === currentStableCurrency}
            className="w-full rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {mutation.isPending ? 'Applying…' : 'Change stable currency'}
          </button>
        </div>
      </div>
      <label className="space-y-1 block">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Reason (2–500 chars, logged in audit)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. user moved from US → UK, support ticket #42"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
      </label>

      {formError !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {formError}
        </div>
      ) : null}

      {lastApplied !== null ? (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
        >
          Stable currency changed:{' '}
          <strong>{displayStable(lastApplied.result.priorStableCurrency)}</strong> →{' '}
          <strong>{displayStable(lastApplied.result.newStableCurrency)}</strong>.
          <ReplayedBadge replayed={lastApplied.replayed} />
        </div>
      ) : null}
    </form>
  );
}
