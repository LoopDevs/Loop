import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { getAdminUserAuthState, clearAdminOtpLockout } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { useStaffRole } from '~/hooks/use-staff-role';
import { useUiStore } from '~/stores/ui.store';
import { ReasonDialog } from './ReasonDialog';
import { ReplayedBadge } from './ReplayedBadge';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * Login / OTP support state panel (readiness-backlog A5-3).
 *
 * READ (support-visible): the B5 verify-otp lockout snapshot
 * (`otp_attempt_counters`), the last OTP request/verify timestamps,
 * and the live-session count — everything support needs to answer
 * "is this user locked out right now, and why" without SQL. Renders
 * for both staff roles, same as `UserWalletCard`.
 *
 * ACTION (admin-only): "Clear OTP lockout" — the incident-response
 * unlock for the common case (legit user fat-fingered the code,
 * needs to retry now). Gated to `isAdminRole` like
 * `RevokeSessionsPanel`, NOT the support-allowed delivery-unsticking
 * actions on this page (wallet re-provision / redemption re-fetch):
 * clearing a brute-force defense is a different risk class from
 * re-driving already-paid-for work, so it stays admin-tier server-side
 * (`apps/backend/src/admin/clear-otp-lockout.ts` has the full
 * reasoning) and this client gate mirrors that. Unlike
 * `RevokeSessionsPanel` this DOES prompt for a reason (`ReasonDialog`)
 * because the backend requires one — the server contract, not a UI
 * choice.
 */
export function AuthStatePanel({
  userId,
  userEmail,
}: {
  userId: string;
  userEmail: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { isAdminRole } = useStaffRole();
  const addToast = useUiStore((s) => s.addToast);
  const [reasonOpen, setReasonOpen] = useState(false);

  const query = useQuery({
    queryKey: ['admin-user-auth-state', userId],
    queryFn: () => getAdminUserAuthState(userId),
    retry: shouldRetry,
    staleTime: 15_000,
  });

  const clearLockout = useMutation({
    mutationFn: (reason: string) => clearAdminOtpLockout({ userId, reason }),
    onSuccess: (envelope) => {
      addToast(
        envelope.audit.replayed
          ? 'Clear-lockout replayed — already cleared by this request.'
          : envelope.result.wasLocked
            ? `OTP lockout cleared for ${userEmail} — they can retry now.`
            : `${userEmail} was not locked — nothing to clear.`,
        'success',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-user-auth-state', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-user-audit', userId] });
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Failed to clear OTP lockout.', 'error');
    },
  });

  const handleReason = (reason: string | null): void => {
    setReasonOpen(false);
    if (reason !== null) clearLockout.mutate(reason);
  };

  const fmt = (iso: string | null): string =>
    iso === null
      ? '—'
      : new Date(iso).toLocaleString(ADMIN_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Auth / login state
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            B5 verify-otp lockout state, OTP request/verify history, and live-session count
            (readiness-backlog A5-3). Read-only for support; the clear action is admin-tier.
          </p>
        </div>
        {query.data !== undefined ? (
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              query.data.otpLock.locked
                ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
            }`}
          >
            {query.data.otpLock.locked ? 'locked' : 'not locked'}
          </span>
        ) : null}
      </header>

      {query.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
          Failed to load auth state.
        </p>
      ) : (
        <div className="space-y-4 px-6 py-5">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Locked until</dt>
              <dd className="text-gray-900 dark:text-white">
                {fmt(query.data.otpLock.lockedUntil)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Failed attempts (current window)</dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {query.data.otpLock.failedAttempts}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Last OTP requested</dt>
              <dd className="text-gray-900 dark:text-white">
                {fmt(query.data.lastOtpRequestedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Last OTP verified</dt>
              <dd className="text-gray-900 dark:text-white">{fmt(query.data.lastOtpVerifiedAt)}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Active sessions</dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {query.data.activeSessionCount}
              </dd>
            </div>
          </dl>

          {isAdminRole ? (
            <div>
              <button
                type="button"
                onClick={() => setReasonOpen(true)}
                disabled={clearLockout.isPending}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {clearLockout.isPending ? 'Clearing…' : 'Clear OTP lockout'}
              </button>
              {clearLockout.data !== undefined ? (
                <ReplayedBadge replayed={clearLockout.data.audit.replayed} />
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <ReasonDialog
        open={reasonOpen}
        title="Reason for clearing the OTP lockout?"
        description="Re-enables login attempts for this account by clearing the B5 verify-otp lockout counter — the same primitive a successful verify already uses. Reversible-ish: further wrong guesses re-arm the lockout from a clean window. Logged in the audit trail and the Discord notification."
        confirmLabel="Clear lockout"
        onResolve={handleReason}
      />
    </section>
  );
}
