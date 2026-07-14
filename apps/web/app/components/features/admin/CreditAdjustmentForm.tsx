import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException, formatMinorCurrency } from '@loop/shared';
import {
  applyCreditAdjustment,
  generateIdempotencyKey,
  type AdminWriteEnvelope,
  type CreditAdjustmentResult,
} from '~/services/admin';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
import { useOnline } from '~/hooks/use-online';
import { ReplayedBadge } from './ReplayedBadge';
import { ConfirmDialog } from './ConfirmDialog';
import { StepUpModal } from './StepUpModal';
import { ADMIN_WRITE_MAX_ABS_MINOR } from './constants';

const CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
type Currency = (typeof CURRENCIES)[number];

interface Props {
  userId: string;
  defaultCurrency: Currency;
}

interface ParsedAmount {
  minorString: string;
  minorBigInt: bigint;
}

/**
 * Parses the `"±12.34"` (or `"±1234"`) text entry into a signed
 * minor-unit string. Accepts:
 *   - optional leading `+` or `-`
 *   - digits
 *   - optional `.` with 0–2 decimal places
 *
 * Anything else → null. We keep the string form (`minorString`) for
 * the wire payload so a very-small-business-prevention amount
 * (out-of-range bigint) doesn't accidentally round-trip through a
 * JS number.
 */
export function parseAmountMajor(raw: string): ParsedAmount | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const decimals = (match[3] ?? '').padEnd(2, '0');
  const fraction = BigInt(decimals);
  const unsigned = whole * 100n + fraction;
  if (unsigned === 0n) return null;
  const signed = sign * unsigned;
  return { minorString: signed.toString(), minorBigInt: signed };
}

export function CreditAdjustmentForm({ userId, defaultCurrency }: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  // FE-43: applying a credit adjustment is a money write. Offline the request
  // can only fail, so disable the submit (with a spoken-aloud reason) until the
  // device reconnects — matching the PayWithLoopBalance offline-guard pattern.
  const online = useOnline();
  const offlineHintId = useId();
  const [amountMajor, setAmountMajor] = useState('');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // A2-1163: track `audit.replayed` alongside `result` so a
  // double-click on Apply doesn't look identical to a fresh write.
  // When the backend replays a stored snapshot, the new reason /
  // amount in the form were ignored — operators need to see that.
  const [lastApplied, setLastApplied] = useState<{
    result: CreditAdjustmentResult;
    replayed: boolean;
  } | null>(null);
  // A4-052: gate the destructive write behind a second-step
  // confirmation dialog. The reason is already captured inline (see
  // textarea below) — this dialog re-displays the parsed amount so
  // an operator can spot a fat-finger before the ledger updates.
  const [pendingPayload, setPendingPayload] = useState<{
    amountMinor: string;
    amountMinorBigInt: bigint;
    currency: Currency;
    reason: string;
    // CF-09: minted once when the operator confirms the intent
    // (pendingPayload is set), then threaded through the writer and
    // reused on the step-up retry so ADR-017 dedup also covers the
    // post-completion re-click — a re-fire re-sends the SAME key.
    idempotencyKey: string;
  } | null>(null);

  // ADR-028 / A4-063: wraps the mutationFn so the step-up auth dance
  // is transparent — if the backend returns 401 STEP_UP_REQUIRED on
  // the first try, the modal opens, mints a fresh token, and the
  // mutation retries.
  const stepUp = useAdminStepUp();

  const mutation = useMutation({
    mutationFn: (args: Parameters<typeof applyCreditAdjustment>[0]) =>
      // P2-07: echo the signed amount + target user the OTP authorizes.
      stepUp.runWithStepUp(() => applyCreditAdjustment(args), {
        action: 'Apply credit adjustment',
        scope: 'credit-adjustment',
        amount: { minor: args.amountMinor, currency: args.currency },
        destination: args.userId,
      }),
    onSuccess: (envelope: AdminWriteEnvelope<CreditAdjustmentResult>) => {
      setLastApplied({ result: envelope.result, replayed: envelope.audit.replayed });
      setAmountMajor('');
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-user-credits', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
    },
    onError: (err) => {
      if (err instanceof ApiException) {
        setFormError(err.message);
      } else if (err instanceof Error) {
        setFormError(err.message);
      } else {
        setFormError('Adjustment failed');
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

    const parsed = parseAmountMajor(amountMajor);
    if (parsed === null) {
      setFormError('Amount must be a non-zero signed number (e.g. +12.34 or -50).');
      return;
    }
    const abs = parsed.minorBigInt < 0n ? -parsed.minorBigInt : parsed.minorBigInt;
    if (abs > ADMIN_WRITE_MAX_ABS_MINOR) {
      setFormError('Amount exceeds the ±100,000 major-unit limit.');
      return;
    }

    setPendingPayload({
      amountMinor: parsed.minorString,
      amountMinorBigInt: parsed.minorBigInt,
      currency,
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
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      reason: payload.reason,
      idempotencyKey: payload.idempotencyKey,
    });
  };

  const dialogBody =
    pendingPayload !== null ? (
      <div className="space-y-2">
        <p>
          Apply{' '}
          <strong className="tabular-nums">
            {formatMinorCurrency(pendingPayload.amountMinor, pendingPayload.currency)}
          </strong>{' '}
          {pendingPayload.amountMinorBigInt < 0n ? 'debit' : 'credit'} to user{' '}
          <code className="font-mono text-xs">{userId}</code>?
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          This is logged in the audit trail and will fire a Discord notification.
        </p>
      </div>
    ) : null;

  return (
    <form className="space-y-4" onSubmit={handleSubmit} aria-labelledby="credit-adjustment-heading">
      <p id="credit-adjustment-heading" className="sr-only">
        Apply credit adjustment
      </p>
      <ConfirmDialog
        open={pendingPayload !== null}
        title="Confirm credit adjustment"
        body={dialogBody}
        confirmLabel="Apply adjustment"
        onResolve={handleConfirm}
      />
      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1 sm:col-span-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Amount (major units)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amountMajor}
            onChange={(e) => setAmountMajor(e.target.value)}
            placeholder="e.g. +12.34 or -50"
            aria-label="Credit adjustment amount in major units, signed"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </label>
        <label className="space-y-1 sm:col-span-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Currency</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            aria-label="Currency"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-1 flex items-end">
          <button
            type="submit"
            disabled={mutation.isPending || !online}
            aria-describedby={!online ? offlineHintId : undefined}
            className="w-full rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {mutation.isPending ? 'Applying…' : 'Apply adjustment'}
          </button>
        </div>
      </div>
      {!online && (
        <p id={offlineHintId} className="text-xs text-gray-500 dark:text-gray-400">
          You’re offline — reconnect to apply the adjustment.
        </p>
      )}
      <label className="space-y-1 block">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Reason (2–500 chars, logged in audit)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. goodwill credit for order #abc failed redemption"
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
          Adjustment applied. New balance:{' '}
          <strong className="tabular-nums">
            {formatMinorCurrency(lastApplied.result.newBalanceMinor, lastApplied.result.currency)}
          </strong>{' '}
          (was{' '}
          {formatMinorCurrency(lastApplied.result.priorBalanceMinor, lastApplied.result.currency)}
          ).
          <ReplayedBadge replayed={lastApplied.replayed} />
        </div>
      ) : null}
    </form>
  );
}
