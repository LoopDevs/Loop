/**
 * Admin step-up confirmation modal (ADR 028, A4-063).
 *
 * Walks the admin through the OTP-based step-up flow:
 *
 *   1. Click "Send code" — POSTs `/api/auth/request-otp` with the
 *      admin's stored email so the backend emails a fresh code.
 *   2. Admin types the 6-digit code → click "Confirm".
 *   3. POSTs `/api/admin/step-up`; on success, the parent's
 *      `onConfirm(token)` callback is invoked with the JWT and the
 *      modal closes. The parent then retries the destructive action
 *      with `X-Admin-Step-Up: <token>` set.
 *
 * Cancellation paths:
 *   - "Cancel" / Esc: invokes `onCancel()` so the destructive
 *     mutation aborts.
 *   - 5-minute idle: the JWT TTL is server-side; if the admin sits
 *     on the modal too long, the next destructive action will trip
 *     STEP_UP_INVALID and re-prompt.
 *
 * Sibling to `ConfirmDialog` — that one is the second-step "are you
 * sure" gate (A4-052/053); this one is the step-up auth gate. Both
 * are needed: ConfirmDialog catches fat-finger amounts, StepUpModal
 * catches stolen-token actor swaps.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiException, formatMinorCurrency } from '@loop/shared';
import { requestOtp } from '~/services/auth';
import { mintAdminStepUp } from '~/services/admin-step-up';
import { useAuthStore } from '~/stores/auth.store';
import { useAdminStepUpStore, type PendingActionSummary } from '~/stores/admin-step-up.store';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';

interface Props {
  /** Called with the freshly-minted step-up JWT on success. */
  onConfirm: (stepUpToken: string, expiresAt: string) => void;
  /** Called when the admin dismisses the modal. */
  onCancel: () => void;
  /**
   * The pending action this OTP authorizes, echoed in the modal body so
   * the code visibly authorizes a SHOWN action (P2-07). Defaults to the
   * summary the step-up store holds (set at initiation by
   * `useAdminStepUp`); an explicit prop overrides it (used in tests).
   */
  pendingAction?: PendingActionSummary;
}

export function StepUpModal({
  onConfirm,
  onCancel,
  pendingAction: pendingActionProp,
}: Props): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  // P2-07: the modal is mounted at ~10 call sites; reading the summary
  // from the store means no caller has to remember to pass a prop for
  // the amount/destination to show. An explicit prop still wins.
  const pendingActionFromStore = useAdminStepUpStore((s) => s.pendingAction);
  const pendingAction = pendingActionProp ?? pendingActionFromStore ?? undefined;
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'idle' | 'sending' | 'awaiting-code' | 'confirming'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Native <dialog> + showModal() — same pattern as ConfirmDialog /
  // ReasonDialog. The browser provides the focus trap, ESC handling,
  // and aria-modal semantics for free; the previous div[role=dialog]
  // shell had none of those while gating destructive admin writes.
  // The parent mounts this component only while the step-up flow is
  // active, so we open the dialog once on mount.
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const otpInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const handleSendCode = async (): Promise<void> => {
    if (email === null) {
      setError('No admin session — log in again.');
      return;
    }
    setError(null);
    setStage('sending');
    try {
      // Reuse the existing OTP path the admin used at login. The
      // backend responds 200 even when the email isn't deliverable
      // (anti-enumeration); the admin will know immediately whether
      // the code arrived.
      await requestOtp(email);
      setStage('awaiting-code');
    } catch (err) {
      setError(friendlyError(err, 'Could not send the verification code.'));
      setStage('idle');
    }
  };

  const handleConfirm = async (): Promise<void> => {
    if (otp.trim().length === 0) {
      setError('Enter the verification code from your email.');
      // Return focus to the field the admin must fill; the Confirm click
      // otherwise strands focus on the button.
      otpInputRef.current?.focus();
      return;
    }
    // SEC-02-stepup: mint a token bound to the exact action-class this
    // step-up authorizes. The scope rides on the pending-action summary
    // (set at initiation by `useAdminStepUp`); without it there is
    // nothing to scope the single-use token to, so fail rather than mint
    // an unusable token.
    if (pendingAction === undefined) {
      setError('Missing action context for step-up. Re-open and try again.');
      return;
    }
    setError(null);
    setStage('confirming');
    try {
      const res = await mintAdminStepUp(otp.trim(), pendingAction.scope);
      onConfirm(res.stepUpToken, res.expiresAt);
    } catch (err) {
      if (err instanceof ApiException && err.status === 503) {
        setError(
          'Admin step-up is not configured on this deployment. Contact ops to generate the signing key.',
        );
      } else {
        setError(friendlyError(err, 'Verification failed. Re-send the code and try again.'));
      }
      setStage('awaiting-code');
      // Return focus to the OTP field so the admin can correct and retry.
      // rAF waits for the re-enabled input to commit (it's disabled while
      // 'confirming'). Matches the ReasonDialog / ConfirmDialog focus idiom.
      requestAnimationFrame(() => otpInputRef.current?.focus());
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onCancel={(e) => {
        // ESC: keep the dialog mounted-but-open state consistent —
        // the parent unmounts us in response to onCancel().
        e.preventDefault();
        onCancel();
      }}
      className="rounded-xl shadow-xl backdrop:bg-black/50 p-0 max-w-md w-[90vw] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      aria-labelledby="step-up-modal-title"
    >
      <div className="p-5">
        <h2
          id="step-up-modal-title"
          className="text-lg font-semibold text-gray-900 dark:text-white mb-2"
        >
          Confirm with your verification code
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          This action requires fresh authentication. We&rsquo;ll email a one-time code to{' '}
          <span className="font-medium">{email ?? 'your admin email'}</span>.
        </p>

        {pendingAction !== undefined && (
          // P2-07: echo what the OTP authorizes so the operator cannot
          // blind-approve an unseen (irreversible) money movement.
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-gray-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-gray-100">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              You are authorizing
            </p>
            <p className="mt-0.5 font-medium">{pendingAction.action}</p>
            {pendingAction.amount !== undefined && (
              <p className="mt-1 font-semibold tabular-nums">
                {'formatted' in pendingAction.amount
                  ? pendingAction.amount.formatted
                  : formatMinorCurrency(pendingAction.amount.minor, pendingAction.amount.currency)}
              </p>
            )}
            {pendingAction.destination !== undefined && (
              <p className="mt-1 text-xs">
                To: <code className="font-mono break-all">{pendingAction.destination}</code>
              </p>
            )}
          </div>
        )}

        {stage === 'idle' && (
          <Button onClick={() => void handleSendCode()} className="w-full">
            Send code
          </Button>
        )}

        {(stage === 'sending' || stage === 'awaiting-code' || stage === 'confirming') && (
          <div className="space-y-3">
            <Input
              ref={otpInputRef}
              type="text"
              label="Verification code"
              value={otp}
              onChange={setOtp}
              inputMode="numeric"
              // A2-1100: let iOS surface the emailed OTP from the
              // notification bar as a keyboard suggestion (Android Autofill
              // does the same via Google Messages), and bring up a numeric
              // keypad for the 6-digit code. Matches the login + onboarding
              // OTP inputs (auth.tsx, signup-tail.tsx).
              autoComplete="one-time-code"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- ADR 042: deliberate UX — this is the sole input on a step that just became active after an explicit user action (submit email / advance a wizard step), not an unexpected focus jump. eslint-plugin-jsx-a11y blanket-disallows autoFocus; WCAG does not. Tracked: docs/readiness-backlog-2026-07-03.md B-2.
              autoFocus
              disabled={stage === 'confirming'}
            />
            <div className="flex gap-2">
              <Button
                onClick={() => void handleConfirm()}
                loading={stage === 'confirming'}
                disabled={otp.trim().length === 0 || stage === 'sending'}
                className="flex-1"
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleSendCode()}
                disabled={stage === 'sending' || stage === 'confirming'}
              >
                Resend
              </Button>
            </div>
          </div>
        )}

        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 w-full text-center text-sm text-gray-500 underline"
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiException) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
