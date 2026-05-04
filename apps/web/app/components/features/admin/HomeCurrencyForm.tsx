import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  setUserHomeCurrency,
  type AdminWriteEnvelope,
  type HomeCurrencySetResult,
} from '~/services/admin';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { ReplayedBadge } from './ReplayedBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { StepUpModal } from './StepUpModal';

const CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
type Currency = (typeof CURRENCIES)[number];

interface Props {
  userId: string;
  /** The user's current home currency, used to seed the dropdown and detect no-ops client-side. */
  currentHomeCurrency: Currency;
}

/**
 * Admin home-currency change form. Same shape as
 * `CreditAdjustmentForm` / `AdminWithdrawalForm`: confirm-dialog
 * gate before submit, step-up auth dance via `useAdminStepUp`,
 * `audit.replayed` badge after submit. Backend enforces the safety
 * preflight (no live balance / no in-flight payouts) and surfaces
 * the failure as a 409 with a witness in the message — we render
 * that verbatim rather than re-implementing the rule client-side.
 */
export function HomeCurrencyForm({ userId, currentHomeCurrency }: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Currency>(currentHomeCurrency);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<{
    result: HomeCurrencySetResult;
    replayed: boolean;
  } | null>(null);
  const [pendingPayload, setPendingPayload] = useState<{
    homeCurrency: Currency;
    reason: string;
  } | null>(null);

  const stepUp = useAdminStepUp();

  const mutation = useMutation({
    mutationFn: (args: Parameters<typeof setUserHomeCurrency>[0]) =>
      stepUp.runWithStepUp(() => setUserHomeCurrency(args)),
    onSuccess: (envelope: AdminWriteEnvelope<HomeCurrencySetResult>) => {
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
        setFormError('Home currency change failed');
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
    if (target === currentHomeCurrency) {
      setFormError(`User is already on ${currentHomeCurrency}.`);
      return;
    }

    setPendingPayload({ homeCurrency: target, reason: trimmedReason });
  };

  const handleConfirm = (confirmed: boolean): void => {
    const payload = pendingPayload;
    setPendingPayload(null);
    if (!confirmed || payload === null) return;
    mutation.mutate({ userId, homeCurrency: payload.homeCurrency, reason: payload.reason });
  };

  const dialogBody =
    pendingPayload !== null ? (
      <div className="space-y-2">
        <p>
          Switch user&rsquo;s home currency from <strong>{currentHomeCurrency}</strong> to{' '}
          <strong>{pendingPayload.homeCurrency}</strong>?
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The backend rejects the change if the user has a non-zero credit balance in{' '}
          {currentHomeCurrency} or any in-flight payouts. This action is logged in the audit trail
          and fires a Discord notification.
        </p>
      </div>
    ) : null;

  return (
    <form className="space-y-4" onSubmit={handleSubmit} aria-labelledby="home-currency-heading">
      <p id="home-currency-heading" className="sr-only">
        Change home currency
      </p>
      <ConfirmDialog
        open={pendingPayload !== null}
        title="Confirm home currency change"
        body={dialogBody}
        confirmLabel="Change home currency"
        onResolve={handleConfirm}
      />
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1 sm:col-span-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            New home currency
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as Currency)}
            aria-label="New home currency"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === currentHomeCurrency ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2 flex items-end">
          <button
            type="submit"
            disabled={mutation.isPending || target === currentHomeCurrency}
            className="w-full rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {mutation.isPending ? 'Applying…' : 'Change home currency'}
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
          Home currency changed: <strong>{lastApplied.result.priorHomeCurrency}</strong> →{' '}
          <strong>{lastApplied.result.newHomeCurrency}</strong>.
          <ReplayedBadge replayed={lastApplied.replayed} />
        </div>
      ) : null}
    </form>
  );
}
