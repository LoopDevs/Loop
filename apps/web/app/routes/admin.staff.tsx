import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiException, type AdminStaffEntry, type StaffRole } from '@loop/shared';
import type { Route } from './+types/admin.staff';
import { shouldRetry } from '~/hooks/query-retry';
import { useAdminStepUp, type PendingActionSummary } from '~/hooks/use-admin-step-up';
import {
  getAdminUserByEmail,
  listAdminStaff,
  revokeStaffRole,
  setStaffRole,
  type AdminUserDetail,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { ConfirmDialog } from '~/components/features/admin/ConfirmDialog';
import { ReasonDialog } from '~/components/features/admin/ReasonDialog';
import { ReplayedBadge } from '~/components/features/admin/ReplayedBadge';
import { StepUpModal } from '~/components/features/admin/StepUpModal';
import { Spinner } from '~/components/ui/Spinner';
import { useUiStore } from '~/stores/ui.store';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Staff — Loop' }];
}

const ROLES: ReadonlyArray<StaffRole> = ['support', 'admin'];

const ROLE_CLASSES: Record<StaffRole, string> = {
  admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  support: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
};

/**
 * `/admin/staff` — staff-role management (ADR 037 §5, ADMIN-ONLY).
 *
 * The first self-serve alternative to the direct-SQL escalation the
 * audit flagged: list current grants, grant/change via email lookup
 * (the form resolves the email to a userId through the existing
 * by-email endpoint before any write), revoke with confirm. Both
 * writes are step-up gated like the money writes (ADR 028) and carry
 * the full ADR 017 envelope — idempotency key, 2–500 char reason,
 * Discord audit.
 */
export default function AdminStaffRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminStaffRouteInner />
    </RequireAdmin>
  );
}

function AdminStaffRouteInner(): React.JSX.Element {
  const queryClient = useQueryClient();
  const addToast = useUiStore((s) => s.addToast);
  const stepUp = useAdminStepUp();
  const [revokeTarget, setRevokeTarget] = useState<AdminStaffEntry | null>(null);

  const staffQuery = useQuery({
    queryKey: ['admin-staff'],
    queryFn: listAdminStaff,
    retry: shouldRetry,
    staleTime: 15_000,
  });

  const revoke = useMutation({
    mutationFn: (args: { userId: string; reason: string }) =>
      // P2-07: echo the role change the OTP authorizes (not a money path).
      stepUp.runWithStepUp(() => revokeStaffRole(args), {
        action: `Revoke staff role from ${args.userId}`,
      }),
    onSuccess: (envelope) => {
      addToast(
        envelope.audit.replayed
          ? 'Revoke replayed — the grant was already removed.'
          : 'Staff role revoked. Takes full effect within the 15-minute token TTL.',
        'success',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-staff'] });
    },
    onError: (err) => {
      addToast(
        err instanceof ApiException ? err.message : 'Failed to revoke the staff role.',
        'error',
      );
    },
  });

  const handleRevokeReason = (reason: string | null): void => {
    const target = revokeTarget;
    setRevokeTarget(null);
    if (reason === null || target === null) return;
    revoke.mutate({ userId: target.userId, reason });
  };

  const staff = staffQuery.data?.staff ?? [];

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Staff roles</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          ADR 037 role grants. <code className="font-mono text-xs">admin</code> can do everything
          including money writes (with step-up); <code className="font-mono text-xs">support</code>{' '}
          sees read views and the three delivery-unsticking actions only. Grants and revocations are
          step-up gated and audited; changes take effect within the 15-minute token TTL.
        </p>
      </header>

      {stepUp.modalOpen && (
        <StepUpModal onConfirm={stepUp.handleStepUpConfirm} onCancel={stepUp.handleStepUpCancel} />
      )}

      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Current staff</h2>
        </header>
        {staffQuery.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : staffQuery.isError ? (
          <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
            Failed to load the staff list.
          </p>
        ) : staff.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">No staff grants yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead>
                <tr>
                  {['Email', 'Role', 'Granted', 'Granted by', 'Reason', ''].map((h, i) => (
                    <th
                      key={`${h}-${String(i)}`}
                      className="px-6 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
                {staff.map((member) => (
                  <tr key={member.userId}>
                    <td className="px-6 py-3">
                      <Link
                        to={`/admin/users/${member.userId}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {member.email}
                      </Link>
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_CLASSES[member.role]}`}
                      >
                        {member.role}
                      </span>
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap text-gray-600 dark:text-gray-400">
                      {member.grantedAt !== null
                        ? new Date(member.grantedAt).toLocaleString(ADMIN_LOCALE, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </td>
                    <td className="px-6 py-3 text-xs text-gray-600 dark:text-gray-400">
                      {member.grantedByEmail ??
                        (member.grantedByUserId !== null ? (
                          <span className="font-mono">{`${member.grantedByUserId.slice(0, 8)}…`}</span>
                        ) : member.source === 'legacy_is_admin' ? (
                          // CTX-allowlist admin with no staff_roles row
                          // yet — the deprecated users.is_admin shim
                          // (ADR 037 §1).
                          'legacy is_admin'
                        ) : (
                          'migration'
                        ))}
                    </td>
                    <td
                      className="max-w-xs truncate px-6 py-3 text-xs text-gray-600 dark:text-gray-400"
                      title={member.reason ?? undefined}
                    >
                      {member.reason ?? '—'}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(member)}
                        disabled={revoke.isPending}
                        className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <GrantForm
        onGranted={() => void queryClient.invalidateQueries({ queryKey: ['admin-staff'] })}
        runWithStepUp={stepUp.runWithStepUp}
      />

      <ReasonDialog
        open={revokeTarget !== null}
        title={
          revokeTarget !== null
            ? `Reason for revoking ${revokeTarget.email}'s ${revokeTarget.role} role?`
            : 'Reason for revoking?'
        }
        description="The reason lands in the audit trail and the Discord notification."
        confirmLabel="Revoke role"
        onResolve={handleRevokeReason}
      />
    </main>
  );
}

/**
 * Grant / change form. Two-step on purpose: the email is resolved to
 * a userId via the existing exact-match lookup BEFORE the write is
 * offered, so a typo'd email fails loudly at lookup time instead of
 * 404ing inside the step-up dance.
 */
function GrantForm({
  onGranted,
  runWithStepUp,
}: {
  onGranted: () => void;
  runWithStepUp: <T>(fn: () => Promise<T>, action?: PendingActionSummary) => Promise<T>;
}): React.JSX.Element {
  const addToast = useUiStore((s) => s.addToast);
  const [email, setEmail] = useState('');
  const [resolved, setResolved] = useState<AdminUserDetail | null>(null);
  const [role, setRole] = useState<StaffRole>('support');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastReplayed, setLastReplayed] = useState(false);

  const lookup = useMutation({
    mutationFn: getAdminUserByEmail,
    onSuccess: (user) => {
      setResolved(user);
      setFormError(null);
    },
    onError: (err) => {
      setResolved(null);
      if (err instanceof ApiException && err.status === 404) {
        setFormError('No user with that email.');
        return;
      }
      setFormError(err instanceof ApiException ? err.message : 'Email lookup failed.');
    },
  });

  const grant = useMutation({
    mutationFn: (args: { userId: string; role: StaffRole; reason: string }) =>
      // P2-07: echo the role grant the OTP authorizes (not a money path).
      runWithStepUp(() => setStaffRole(args), {
        action: `Grant ${args.role} role to ${args.userId}`,
      }),
    onSuccess: (envelope) => {
      setLastReplayed(envelope.audit.replayed);
      addToast(
        envelope.audit.replayed
          ? 'Grant replayed — this exact grant was already applied.'
          : `Granted ${envelope.result.role} to ${resolved?.email ?? envelope.result.userId}.`,
        'success',
      );
      setEmail('');
      setResolved(null);
      setReason('');
      setFormError(null);
      onGranted();
    },
    onError: (err) => {
      setFormError(err instanceof ApiException ? err.message : 'Failed to grant the staff role.');
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setFormError(null);
    setLastReplayed(false);
    if (resolved === null) {
      setFormError('Resolve the email to a user first.');
      return;
    }
    const trimmed = reason.trim();
    if (trimmed.length < 2 || trimmed.length > 500) {
      setFormError('Reason must be 2–500 characters.');
      return;
    }
    setConfirming(true);
  };

  const handleConfirm = (confirmed: boolean): void => {
    setConfirming(false);
    if (!confirmed || resolved === null) return;
    grant.mutate({ userId: resolved.id, role, reason: reason.trim() });
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Grant a role</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Look the user up by email first; the grant itself requires step-up verification.
        </p>
      </header>
      <form className="space-y-4 px-6 py-5" onSubmit={handleSubmit}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grow space-y-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setResolved(null);
              }}
              placeholder="person@example.com"
              aria-label="Email of the user to grant a role to"
              className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
          <button
            type="button"
            onClick={() => lookup.mutate(email.trim())}
            disabled={email.trim().length === 0 || lookup.isPending}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {lookup.isPending ? 'Looking up…' : 'Look up'}
          </button>
        </div>

        {resolved !== null ? (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            Resolved: <span className="font-medium">{resolved.email}</span>{' '}
            <code className="font-mono">{resolved.id}</code>
            {resolved.isAdmin ? ' (currently admin)' : ''}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-xs font-medium text-gray-600 dark:text-gray-400">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'support')}
              aria-label="Role to grant"
              className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-gray-600 dark:text-gray-400 sm:col-span-2">
            Reason (2–500 chars, audited)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Onboarding Jo to support rotation — ticket OPS-123"
              aria-label="Reason for the grant"
              className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={grant.isPending || resolved === null}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {grant.isPending ? 'Granting…' : 'Grant role'}
          </button>
          <ReplayedBadge replayed={lastReplayed} />
        </div>

        {formError !== null ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
          </p>
        ) : null}
      </form>

      <ConfirmDialog
        open={confirming}
        title="Confirm role grant"
        body={
          resolved !== null ? (
            <p>
              Grant <strong>{role}</strong> to <strong>{resolved.email}</strong>? You&rsquo;ll be
              asked for a step-up verification code; the grant is audited and fires a Discord
              notification.
            </p>
          ) : null
        }
        confirmLabel="Grant"
        onResolve={handleConfirm}
      />
    </section>
  );
}
