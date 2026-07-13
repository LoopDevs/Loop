import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiException, formatMinorCurrency, STELLAR_PUBKEY_REGEX } from '@loop/shared';
import {
  applyAdminEmission,
  generateIdempotencyKey,
  type AdminWriteEnvelope,
  type EmissionResult,
} from '~/services/admin';
import { useAdminStepUp } from '~/hooks/use-admin-step-up';
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

export function parseUnsignedAmountMajor(raw: string): ParsedAmount | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const decimals = (match[2] ?? '').padEnd(2, '0');
  const fraction = BigInt(decimals);
  const unsigned = whole * 100n + fraction;
  if (unsigned === 0n) return null;
  return { minorString: unsigned.toString(), minorBigInt: unsigned };
}

export function AdminEmissionForm({ userId, defaultCurrency }: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const [amountMajor, setAmountMajor] = useState('');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [destinationAddress, setDestinationAddress] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<{
    result: EmissionResult;
    replayed: boolean;
  } | null>(null);
  // A4-053: gate the on-chain payout queue behind a second-step
  // confirmation. The destination address is the highest-stakes
  // typo target on the admin surface — once the worker picks it
  // up, no recall.
  const [pendingPayload, setPendingPayload] = useState<{
    amountMinor: string;
    currency: Currency;
    destinationAddress: string;
    reason: string;
    // CF-09: minted once at confirm time, reused on the step-up retry
    // so ADR-017 dedup covers the post-completion re-click.
    idempotencyKey: string;
  } | null>(null);

  // ADR-028 / A4-063: same step-up wrap as the credit-adjust form.
  const stepUp = useAdminStepUp();

  const mutation = useMutation({
    mutationFn: (args: Parameters<typeof applyAdminEmission>[0]) =>
      // P2-07: echo what the step-up OTP authorizes — a Stellar emission
      // is irreversible once the payout worker fires, so the operator
      // must see the amount + destination on the OTP surface itself.
      stepUp.runWithStepUp(() => applyAdminEmission(args), {
        action: 'Queue emission',
        amount: { minor: args.amountMinor, currency: args.currency },
        destination: args.destinationAddress,
      }),
    onSuccess: (envelope: AdminWriteEnvelope<EmissionResult>) => {
      setLastApplied({ result: envelope.result, replayed: envelope.audit.replayed });
      setAmountMajor('');
      setReason('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-user-credits', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-treasury'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
    },
    onError: (err) => {
      if (err instanceof ApiException) {
        setFormError(err.message);
      } else if (err instanceof Error) {
        setFormError(err.message);
      } else {
        setFormError('Emission failed');
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

    const parsed = parseUnsignedAmountMajor(amountMajor);
    if (parsed === null) {
      setFormError('Amount must be a positive number (e.g. 12.34 or 50).');
      return;
    }
    if (parsed.minorBigInt > ADMIN_WRITE_MAX_ABS_MINOR) {
      setFormError('Amount exceeds the 100,000 major-unit limit.');
      return;
    }

    const trimmedAddress = destinationAddress.trim();
    if (!STELLAR_PUBKEY_REGEX.test(trimmedAddress)) {
      setFormError('Destination must be a Stellar public key (starts with G, 56 chars).');
      return;
    }

    setPendingPayload({
      amountMinor: parsed.minorString,
      currency,
      destinationAddress: trimmedAddress,
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
      destinationAddress: payload.destinationAddress,
      reason: payload.reason,
      idempotencyKey: payload.idempotencyKey,
    });
  };

  const dialogBody =
    pendingPayload !== null ? (
      <div className="space-y-2">
        <p>
          Queue an emission of{' '}
          <strong className="tabular-nums">
            {formatMinorCurrency(pendingPayload.amountMinor, pendingPayload.currency)}
          </strong>{' '}
          for user <code className="font-mono text-xs">{userId}</code>?
        </p>
        <p className="text-xs">
          Destination:{' '}
          <code className="font-mono break-all">{pendingPayload.destinationAddress}</code>
        </p>
        <p className="text-xs text-red-600 dark:text-red-400">
          The payout-submit worker fires irreversibly once queued. Verify the destination address.
        </p>
      </div>
    ) : null;

  return (
    <form className="space-y-4" onSubmit={handleSubmit} aria-labelledby="admin-emission-heading">
      <p id="admin-emission-heading" className="sr-only">
        Apply admin emission
      </p>
      <ConfirmDialog
        open={pendingPayload !== null}
        title="Confirm emission"
        body={dialogBody}
        confirmLabel="Queue emission"
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
            placeholder="e.g. 12.34"
            aria-label="Emission amount in major units"
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
            disabled={mutation.isPending}
            className="w-full rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {mutation.isPending ? 'Queueing…' : 'Queue emission'}
          </button>
        </div>
      </div>
      <label className="space-y-1 block">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Destination Stellar address (G…)
        </span>
        <input
          type="text"
          value={destinationAddress}
          onChange={(e) => setDestinationAddress(e.target.value)}
          placeholder="GA7QYNF7…"
          aria-label="Destination Stellar address"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
      </label>
      <label className="space-y-1 block">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Reason (2–500 chars, logged in audit)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. backfill of failed cashback payout — ticket #abc"
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
          Emission queued. Mirror balance unchanged (ADR 036):{' '}
          <strong className="tabular-nums">
            {formatMinorCurrency(lastApplied.result.balanceMinor, lastApplied.result.currency)}
          </strong>
          . Payout id <code className="font-mono text-xs">{lastApplied.result.payoutId}</code>.
          <ReplayedBadge replayed={lastApplied.replayed} />
        </div>
      ) : null}
    </form>
  );
}
