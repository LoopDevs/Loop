/**
 * `/settings/privacy` — in-app data export + account deletion
 * (CF-26 / X-PRIV-01).
 *
 * The backend DSR primitives already exist (ADR-009 anonymisation):
 *   - GET  /api/users/me/dsr/export → machine-readable JSON of every
 *     row Loop holds keyed to the caller (redeem codes excluded).
 *   - POST /api/users/me/dsr/delete → anonymises the account; returns
 *     409 with a typed code when money / fulfilment is in flight.
 *
 * This screen wires both. It is **deliberately NOT behind `Phase2Gate`**
 * — data export and account deletion are GDPR Art. 15/17 rights and an
 * Apple App Store Guideline 5.1.1(v) submission requirement, so they
 * must be reachable in Phase-1 discount mode, unlike the wallet /
 * cashback screens.
 *
 * Deletion is gated behind a typed-confirmation ("DELETE") so a stray
 * tap can't anonymise an account; the server takes no confirmation
 * token, so this is the UX-layer guard the handler header references.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/settings.privacy';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Button } from '~/components/ui/Button';
import { downloadMyData, getMyDataExport, requestAccountDeletion } from '~/services/user';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Privacy & data — Loop' }];
}

const CONFIRM_PHRASE = 'DELETE';

/** Maps the backend's typed 409 deletion-block codes to UX copy. */
function deletionBlockMessage(err: unknown): string {
  if (err instanceof ApiException) {
    if (err.code === 'PENDING_PAYOUTS') {
      return 'You have a cashback payout in flight. Wait for it to settle, then try again — or contact support.';
    }
    if (err.code === 'IN_FLIGHT_ORDERS') {
      return 'You have an order being fulfilled. Wait for it to finish (or expire), then try again — or contact support.';
    }
    if (err.code === 'FAILED_UNCOMPENSATED_WITHDRAWALS') {
      return 'A failed withdrawal is awaiting compensation. Contact support about it before deleting your account.';
    }
    return err.message;
  }
  return 'Something went wrong. Please try again, or email privacy@loopfinance.io.';
}

export default function SettingsPrivacyRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();
  const { isNative } = useNativePlatform();

  const [exportState, setExportState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'working'>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Privacy &amp; data
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">
          Sign in to export your data or delete your account.
        </p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Go to sign-in
        </button>
      </main>
    );
  }

  const handleExport = (): void => {
    if (exportState === 'working') return;
    setExportError(null);
    setExportState('working');
    void (async () => {
      try {
        if (isNative) {
          // Native has no anchor-download; surface the JSON so the user
          // can still capture it. (A first-class native file-save is a
          // follow-up; the data is the right that matters here.)
          const payload = await getMyDataExport();
          // eslint-disable-next-line no-console
          console.log('[loop] your data export', payload);
          setExportState('done');
          return;
        }
        await downloadMyData();
        setExportState('done');
      } catch (err) {
        setExportError(
          err instanceof ApiException
            ? err.message
            : "Couldn't build your export. Please try again, or email privacy@loopfinance.io.",
        );
        setExportState('error');
      }
    })();
  };

  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_PHRASE;

  const handleDelete = (): void => {
    if (!confirmed || deleteState === 'working') return;
    setDeleteError(null);
    setDeleteState('working');
    void (async () => {
      try {
        await requestAccountDeletion();
        // Session is dead server-side now; clear local + leave.
        await logout();
        void navigate('/');
      } catch (err) {
        setDeleteError(deletionBlockMessage(err));
        setDeleteState('idle');
      }
    })();
  };

  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Privacy &amp; data</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Export the data we hold about you, or permanently delete your account. See our{' '}
          <a href="/privacy" className="text-blue-600 underline">
            privacy policy
          </a>{' '}
          for what we collect and why.
        </p>
      </header>

      {/* Data export (GDPR Art. 15 / 20) */}
      <section
        aria-labelledby="export-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="export-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          Export your data
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Download a machine-readable copy of everything tied to your account — profile, credit
          ledger, orders, and payouts. Gift-card codes are not included for security; you can always
          view them on the relevant order.
        </p>
        <Button variant="secondary" onClick={handleExport} disabled={exportState === 'working'}>
          {exportState === 'working' ? 'Preparing…' : 'Download my data'}
        </Button>
        {exportState === 'done' ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-green-700 dark:text-green-400"
          >
            {isNative
              ? 'Your data was prepared. To save a copy on mobile, contact privacy@loopfinance.io.'
              : 'Your data download has started.'}
          </p>
        ) : null}
        {exportError !== null ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {exportError}
          </p>
        ) : null}
      </section>

      {/* Account deletion (GDPR Art. 17 — right of erasure) */}
      <section
        aria-labelledby="delete-heading"
        className="rounded-xl border border-red-200 dark:border-red-900 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="delete-heading" className="text-base font-semibold text-red-700 dark:text-red-400">
          Delete your account
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          This permanently removes your personal data and signs you out everywhere. For legal and
          tax reasons we keep an anonymised transaction record, but it no longer links to you. This
          can&rsquo;t be undone. If you have a payout or order in flight, finish or wait for it
          first.
        </p>
        <label htmlFor="delete-confirm" className="block">
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Type <strong>{CONFIRM_PHRASE}</strong> to confirm
          </span>
          <input
            id="delete-confirm"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:placeholder-gray-600"
          />
        </label>
        {deleteError !== null ? (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            {deleteError}
          </p>
        ) : null}
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={!confirmed || deleteState === 'working'}
        >
          {deleteState === 'working' ? 'Deleting…' : 'Delete my account'}
        </Button>
      </section>
    </main>
  );
}
