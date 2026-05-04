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
import { useState } from 'react';
import { ApiException } from '@loop/shared';
import { requestOtp } from '~/services/auth';
import { mintAdminStepUp } from '~/services/admin-step-up';
import { useAuthStore } from '~/stores/auth.store';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';

interface Props {
  /** Called with the freshly-minted step-up JWT on success. */
  onConfirm: (stepUpToken: string, expiresAt: string) => void;
  /** Called when the admin dismisses the modal. */
  onCancel: () => void;
}

export function StepUpModal({ onConfirm, onCancel }: Props): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'idle' | 'sending' | 'awaiting-code' | 'confirming'>('idle');
  const [error, setError] = useState<string | null>(null);

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
      return;
    }
    setError(null);
    setStage('confirming');
    try {
      const res = await mintAdminStepUp(otp.trim());
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
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-modal-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-900 p-5 shadow-xl">
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

        {stage === 'idle' && (
          <Button onClick={() => void handleSendCode()} className="w-full">
            Send code
          </Button>
        )}

        {(stage === 'sending' || stage === 'awaiting-code' || stage === 'confirming') && (
          <div className="space-y-3">
            <Input
              type="text"
              label="Verification code"
              value={otp}
              onChange={setOtp}
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

        {error !== null && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 w-full text-center text-sm text-gray-500 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiException) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
