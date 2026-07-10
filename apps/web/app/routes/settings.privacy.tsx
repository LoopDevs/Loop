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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/settings.privacy';
import i18n from '~/i18n/i18next';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { Button } from '~/components/ui/Button';
import { downloadMyData, getMyDataExport, requestAccountDeletion } from '~/services/user';
import { signOutAllDevices } from '~/services/auth';
import { shareJsonFile } from '~/native/share';

export function meta(): Route.MetaDescriptors {
  return [{ title: i18n.t('settings:privacy.meta.title') }];
}

const CONFIRM_PHRASE = 'DELETE';

/**
 * Maps the backend's typed 409 deletion-block codes to UX copy. Plain
 * helper function (not a component) — `t` is threaded in from the
 * caller's `useTranslation('settings')`, same pattern as
 * `routes/auth.tsx`'s `ledgerLabel(t, type)` (see docs/i18n.md #3).
 */
function deletionBlockMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiException) {
    if (err.code === 'PENDING_PAYOUTS') {
      return t('privacy.delete.blockedPendingPayouts');
    }
    if (err.code === 'IN_FLIGHT_ORDERS') {
      return t('privacy.delete.blockedInFlightOrders');
    }
    if (err.code === 'FAILED_UNCOMPENSATED_WITHDRAWALS') {
      return t('privacy.delete.blockedFailedWithdrawals');
    }
    if (err.code === 'BALANCE_NOT_ZERO') {
      return t('privacy.delete.blockedBalanceNotZero');
    }
    return err.message;
  }
  return t('privacy.delete.fallbackError');
}

export default function SettingsPrivacyRoute(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();
  const { isNative } = useNativePlatform();

  const [exportState, setExportState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'working'>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // B4: "sign out of all devices" — revoke every session, then clear
  // local state (this device signs out too, which is the expected UX).
  const [signOutAllState, setSignOutAllState] = useState<'idle' | 'working'>('idle');
  const [signOutAllError, setSignOutAllError] = useState<string | null>(null);
  const handleSignOutAll = (): void => {
    setSignOutAllError(null);
    setSignOutAllState('working');
    void (async () => {
      try {
        await signOutAllDevices();
        await logout();
        void navigate('/');
      } catch (err) {
        setSignOutAllError(err instanceof ApiException ? err.message : t('privacy.sessions.error'));
        setSignOutAllState('idle');
      }
    })();
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          {t('privacy.signedOut.heading')}
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">{t('privacy.signedOut.body')}</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          {t('privacy.signedOut.cta')}
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
          // W30-02 (2026-06-30 cold audit): native has no anchor-
          // download, so write the export JSON to Directory.Cache and
          // open the OS share sheet — the user can save/AirDrop/email
          // the file to actually retrieve it (GDPR Art. 15/20).
          const payload = await getMyDataExport();
          const shared = await shareJsonFile(
            `loop-data-export-${new Date().toISOString().slice(0, 10)}.json`,
            payload,
            {
              title: t('privacy.export.shareTitle'),
              text: t('privacy.export.shareText'),
            },
          );
          if (!shared) {
            setExportError(t('privacy.export.shareError'));
            setExportState('error');
            return;
          }
          setExportState('done');
          return;
        }
        await downloadMyData();
        setExportState('done');
      } catch (err) {
        setExportError(err instanceof ApiException ? err.message : t('privacy.export.exportError'));
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
        setDeleteError(deletionBlockMessage(t, err));
        setDeleteState('idle');
      }
    })();
  };

  return (
    <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('privacy.heading')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t('privacy.introPrefix')}{' '}
          <a href="/privacy" className="text-blue-600 underline">
            {t('privacy.introLink')}
          </a>{' '}
          {t('privacy.introSuffix')}
        </p>
      </header>

      {/* Data export (GDPR Art. 15 / 20) */}
      <section
        aria-labelledby="export-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="export-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          {t('privacy.export.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('privacy.export.body')}</p>
        <Button variant="secondary" onClick={handleExport} disabled={exportState === 'working'}>
          {exportState === 'working' ? t('privacy.export.working') : t('privacy.export.cta')}
        </Button>
        {exportState === 'done' ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-green-700 dark:text-green-400"
          >
            {isNative ? t('privacy.export.doneNative') : t('privacy.export.doneWeb')}
          </p>
        ) : null}
        {exportError !== null ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {exportError}
          </p>
        ) : null}
      </section>

      {/* Session security (B4) */}
      <section
        aria-labelledby="sessions-heading"
        className="rounded-xl border border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="sessions-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          {t('privacy.sessions.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('privacy.sessions.body')}</p>
        <Button
          variant="secondary"
          onClick={handleSignOutAll}
          disabled={signOutAllState === 'working'}
        >
          {signOutAllState === 'working'
            ? t('privacy.sessions.working')
            : t('privacy.sessions.cta')}
        </Button>
        {signOutAllError !== null ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {signOutAllError}
          </p>
        ) : null}
      </section>

      {/* Account deletion (GDPR Art. 17 — right of erasure) */}
      <section
        aria-labelledby="delete-heading"
        className="rounded-xl border border-red-200 dark:border-red-900 p-5 bg-white dark:bg-gray-900 space-y-4"
      >
        <h2 id="delete-heading" className="text-base font-semibold text-red-700 dark:text-red-400">
          {t('privacy.delete.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('privacy.delete.body')}</p>
        <label htmlFor="delete-confirm" className="block">
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('privacy.delete.confirmLabelPrefix')} <strong>{CONFIRM_PHRASE}</strong>{' '}
            {t('privacy.delete.confirmLabelSuffix')}
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
          {deleteState === 'working' ? t('privacy.delete.working') : t('privacy.delete.cta')}
        </Button>
      </section>
    </main>
  );
}
