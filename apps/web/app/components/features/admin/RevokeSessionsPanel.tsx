import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { useStaffRole } from '~/hooks/use-staff-role';
import { revokeUserSessions, type AdminRevokeSessionsResult } from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Session-revocation panel (hardening B4 / readiness-backlog A5-2).
 * `POST /api/admin/users/:userId/revoke-sessions` shipped with zero
 * UI — the only way to kill a compromised user's sessions was curl.
 * This panel is the incident-response lever: it revokes every live
 * refresh token for the user, so any session dies within at most the
 * 15-min access-token TTL (access tokens are non-revocable by
 * design — see `docs/threat-model.md`).
 *
 * Admin-tier (`requireStaff('admin')` server-side — session
 * revocation isn't part of the support-tier delivery-unsticking set
 * in ADR 037), so this self-hides for non-admin staff exactly like
 * `OrderRedrivePanel`. That client gate is UX only; the server-side
 * `requireStaff('admin')` check is the real boundary.
 *
 * Unlike the money-write panels (`OrderRedrivePanel`,
 * `CreditAdjustmentForm`), this endpoint is **not** step-up gated and
 * doesn't take a `reason` — both deliberate backend choices (see
 * `apps/backend/src/auth/revoke-sessions-handler.ts`): revoking
 * sessions moves no value and is fully reversible (the user just
 * signs back in), so gating a fast security response behind a fresh
 * step-up or a typed justification would add friction without a
 * matching safety benefit. The UI mirrors that real contract — a
 * plain `ConfirmDialog` (no reason capture that the backend would
 * silently discard) and no step-up dance — rather than imposing the
 * ADR 017 envelope shape used by the other panels on this page.
 */
export function RevokeSessionsPanel({
  userId,
  userEmail,
}: {
  userId: string;
  userEmail: string;
}): React.JSX.Element | null {
  const { isAdminRole } = useStaffRole();
  const addToast = useUiStore((s) => s.addToast);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [last, setLast] = useState<AdminRevokeSessionsResult | null>(null);

  const revoke = useMutation({
    mutationFn: () => revokeUserSessions(userId),
    onSuccess: (result) => {
      setLast(result);
      addToast(`All sessions revoked for ${userEmail}.`, 'success');
    },
    onError: (err) => {
      addToast(err instanceof ApiException ? err.message : 'Failed to revoke sessions.', 'error');
    },
  });

  const handleConfirm = (confirmed: boolean): void => {
    setConfirmOpen(false);
    if (confirmed) revoke.mutate();
  };

  if (!isAdminRole) return null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <ConfirmDialog
        open={confirmOpen}
        title="Revoke all sessions?"
        body={
          // Deliberately not isolated in its own element (e.g. a
          // `<strong>` wrapping just the email) — the user-360 header
          // already renders the bare email in an `<h1>`, and a second
          // leaf node with the exact same text content would make
          // `getByText(email)` ambiguous for any consumer of this page.
          <>
            This immediately revokes every live refresh token for {userEmail} — they&rsquo;re signed
            out of every device. Already-issued access tokens keep working for up to 15 minutes
            (they can&rsquo;t be revoked directly). The user can sign back in right away; this does
            not lock the account. Use this when a session may be compromised.
          </>
        }
        confirmLabel="Revoke sessions"
        confirmVariant="destructive"
        onResolve={handleConfirm}
      />
      <header className="flex items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Sessions (B4)
        </h2>
      </header>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Incident-response lever: revokes every live refresh token for this user. Access tokens
        already issued stay valid for up to 15 minutes by design (see{' '}
        <code className="font-mono text-xs">docs/threat-model.md</code>).
      </p>
      {last !== null ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{last.message}</p>
      ) : null}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={revoke.isPending}
          className="rounded-lg border border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-600"
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke all sessions'}
        </button>
      </div>
    </section>
  );
}
