import { useCallback, useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { Route } from './+types/auth';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAppConfig } from '~/hooks/use-app-config';
import { useUiStore } from '~/stores/ui.store';
import type { ThemePreference } from '~/stores/ui.store';
import { shouldRetry } from '~/hooks/query-retry';
import { Navbar } from '~/components/features/Navbar';
import { PageHeader } from '~/components/ui/PageHeader';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { GoogleSignInButton } from '~/components/features/auth/GoogleSignInButton';
import { checkBiometrics, authenticateWithBiometrics } from '~/native/biometrics';
import { isAppLockEnabled, setAppLockEnabled } from '~/native/app-lock';
import {
  getMe,
  getCashbackHistory,
  type CashbackHistoryEntry,
  type UserMeView,
} from '~/services/user';
import { PendingCashbackChip } from '~/components/features/cashback/PendingCashbackChip';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Sign in — Loop' }];
}

type AuthStep = 'email' | 'otp';

function ThemeToggleRow(): React.JSX.Element {
  const { themePreference, setThemePreference } = useUiStore();

  const options: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const handleCycle = (): void => {
    const idx = options.findIndex((o) => o.value === themePreference);
    const next = options[(idx + 1) % options.length]!;
    setThemePreference(next.value);
  };

  return (
    <button
      type="button"
      onClick={handleCycle}
      className="w-full flex items-center justify-between px-4 py-3 min-h-[44px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm"
    >
      <span className="text-gray-700 dark:text-gray-300">Appearance</span>
      <span className="text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
        {themePreference === 'dark' ? (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
            />
          </svg>
        ) : themePreference === 'light' ? (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
            />
          </svg>
        ) : null}
        {themePreference === 'dark' ? 'Dark' : themePreference === 'light' ? 'Light' : 'System'}
      </span>
    </button>
  );
}

function BiometricLockRow(): React.JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [biometryType, setBiometryType] = useState<string>('');

  useEffect(() => {
    // Cancellation guard — the check is async and may resolve after the
    // component has unmounted (user navigates away from /auth mid-check).
    // Without this, the setState calls below would fire on an unmounted
    // tree and warn in React 18 / silently drop in 19.
    let cancelled = false;
    void (async () => {
      const result = await checkBiometrics();
      if (cancelled) return;
      setAvailable(result.available);
      setBiometryType(
        result.biometryType === 'face'
          ? 'Face ID'
          : result.biometryType === 'fingerprint'
            ? 'Touch ID'
            : 'Biometrics',
      );
      if (result.available) {
        const lockEnabled = await isAppLockEnabled();
        if (!cancelled) setEnabled(lockEnabled);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) return null;

  const handleToggle = async (): Promise<void> => {
    // Disabling must require biometrics too, not just enabling. Otherwise a
    // thief with an already-unlocked phone can open account settings and
    // turn the lock off — completely defeating the purpose of the feature
    // for every future launch. Both directions of the toggle require the
    // same proof of presence.
    const ok = await authenticateWithBiometrics(
      enabled ? `Disable ${biometryType}` : `Enable ${biometryType}`,
    );
    if (!ok) return;
    const next = !enabled;
    await setAppLockEnabled(next);
    setEnabled(next);
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleToggle();
      }}
      className="w-full flex items-center justify-between px-4 py-3 min-h-[44px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm"
    >
      <span className="text-gray-700 dark:text-gray-300">{biometryType} Lock</span>
      <span className={`text-sm font-medium ${enabled ? 'text-green-600' : 'text-gray-400'}`}>
        {enabled ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/**
 * Formats a minor-units bigint-string into the account view's
 * headline cashback balance. Falls back to `—` for parse errors so
 * a bad server response degrades gracefully rather than crashing
 * the Account screen.
 */
function formatCashbackBalance(minor: string, currency: 'USD' | 'GBP' | 'EUR'): string {
  try {
    const asCents = BigInt(minor);
    const major = Number(asCents) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return '—';
  }
}

/**
 * `Your cashback` card on the Account screen. Shows the user's
 * off-chain balance in their home currency (ADR 015). Zero-balance
 * users still see the card so "you have 0.00 cashback" is a clear
 * state rather than an empty container.
 */
function CashbackBalanceCard({
  me,
  isLoading,
}: {
  me: UserMeView | undefined;
  isLoading: boolean;
}): React.JSX.Element {
  return (
    <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-4">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Your cashback
      </p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
        {isLoading || me === undefined
          ? '—'
          : formatCashbackBalance(me.homeCurrencyBalanceMinor, me.homeCurrency)}
      </p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Earned on every Loop order.
        {me?.stellarAddress === null ? ' Link a wallet to withdraw.' : ''}
      </p>
    </div>
  );
}

/**
 * Formats a ledger row's bigint-minor amount into the caller's
 * locale currency. Entries carry their own `currency` (USD / GBP /
 * EUR) — we honour it per-row in case a support edit introduces a
 * cross-currency row against the user's home currency.
 */
function formatLedgerAmount(minor: string, currency: string): string {
  try {
    const asCents = BigInt(minor);
    const major = Number(asCents) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      // Keep the +/- sign so credits and debits read at a glance.
      signDisplay: 'always',
    }).format(major);
  } catch {
    return '—';
  }
}

/**
 * Maps a ledger `type` to the human-readable label the Account card
 * renders. Keeps the card compact — the full detail (referenceId
 * etc.) lives in a follow-up dedicated page.
 */
const LEDGER_LABELS: Record<CashbackHistoryEntry['type'], string> = {
  cashback: 'Cashback',
  interest: 'Interest',
  spend: 'Spend',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

/**
 * Recent-cashback card on the Account screen. Renders up to 5 of
 * the caller's newest credit-ledger events. Hidden for unauthenticated
 * users (the parent already gates on `isAuthenticated`). Zero-row
 * state renders a "no cashback yet" hint so new users see what the
 * card is going to show once they place an order.
 */
function CashbackHistoryCard({
  entries,
  isLoading,
  isError,
}: {
  entries: CashbackHistoryEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
}): React.JSX.Element | null {
  // Swallow the error state entirely rather than surfacing a red banner
  // to the user — the history card is supplementary to the balance,
  // which is the source of truth. The next `['me']` refetch will retry.
  if (isError) return null;
  const shown = entries?.slice(0, 5) ?? [];
  return (
    <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-4 text-left">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Recent activity
      </p>
      {isLoading ? (
        <p className="mt-3 text-sm text-gray-400 dark:text-gray-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          No cashback yet — your first Loop order will land here.
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-3">
            {shown.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                    {LEDGER_LABELS[entry.type]}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {new Date(entry.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <p
                  className={`shrink-0 text-sm font-medium ${
                    entry.amountMinor.startsWith('-')
                      ? 'text-gray-500 dark:text-gray-400'
                      : 'text-green-600 dark:text-green-500'
                  }`}
                >
                  {formatLedgerAmount(entry.amountMinor, entry.currency)}
                </p>
              </li>
            ))}
          </ul>
          {/* Tap-through to the full paginated history (ADR 009 / 015 —
              /settings/cashback). Only shown when there's history to
              see; empty-state users stay on a single row of copy. */}
          <Link
            to="/settings/cashback"
            className="mt-4 block text-center text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            See all activity →
          </Link>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
          Something went wrong
        </h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">
          We couldn&apos;t load the sign-in page.
        </p>
        <a href="/auth" className="text-blue-600 underline">
          Try again
        </a>
      </div>
    </div>
  );
}

export default function AuthRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const {
    email: userEmail,
    isAuthenticated,
    requestOtp,
    verifyOtp: verifyAndStore,
    signInWithGoogle,
    logout,
  } = useAuth();
  const { isNative } = useNativePlatform();
  const { config } = useAppConfig();
  const googleClientId = isNative
    ? (config.social.googleClientIdIos ?? config.social.googleClientIdAndroid)
    : config.social.googleClientIdWeb;

  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull profile + home-currency balance for the Account view. Shared
  // `['me']` cache key so /settings/wallet mutations refresh this
  // card too. `enabled` gates on auth so the fetch doesn't fire on
  // the unauthenticated marketing view.
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  // Recent credit-ledger events for the "Recent activity" card. Cap
  // the page size at 5 — the card only renders that many; the full
  // list will live on a follow-up dedicated page. Separate cache key
  // from `['me']` because balance and history invalidate on different
  // triggers (a support adjustment writes both; a refund write might
  // only refresh the history).
  const historyQuery = useQuery({
    queryKey: ['me', 'cashback-history'],
    queryFn: () => getCashbackHistory({ limit: 5 }),
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const handleGoogleCredential = useCallback(
    (idToken: string) => {
      setError(null);
      setIsLoading(true);
      void signInWithGoogle(idToken)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Google sign-in failed.');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    // signInWithGoogle identity is stable via useAuthStore; the
    // setters from local useState are stable too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // If authenticated, show account view. The outer container fills
  // the viewport as background (no forced `min-h-screen`/`min-h-[80vh]`
  // stack that used to push content past the viewport and trigger
  // vertical scrolling alongside the bottom tab bar), and the inner
  // block centres with regular padding.
  if (isAuthenticated) {
    // NOTE: intentionally no `min-h-screen` here. NativeShell wraps
    // this route with `native-safe-page native-tab-clearance`, which
    // already contributes ~150px of combined top + bottom padding on
    // device. Adding `min-h-screen` on top forced the inner block to
    // 100vh, so the outer tree ended up at 100vh + 150px — guaranteed
    // vertical scroll. Letting the page size to its content keeps it
    // inside the viewport; the body background handles the area below.
    return (
      <>
        {!isNative && <Navbar />}
        <PageHeader title="Account" fallbackHref="/" />
        {/* Native only clears the PageHeader row (`h-14` = 3.5rem);
            NativeShell's `native-safe-page` already adds the
            safe-top padding. Web: `pt-20` clears the fixed Navbar. */}
        <div className={`flex flex-col items-center px-4 pb-4 ${isNative ? 'pt-16' : 'pt-20'}`}>
          <div className="w-full max-w-sm text-center">
            <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">👤</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Your account</h1>
            <p className="text-gray-500 dark:text-gray-400 mb-6">{userEmail}</p>
            <CashbackBalanceCard me={meQuery.data} isLoading={meQuery.isLoading} />
            <PendingCashbackChip />
            <CashbackHistoryCard
              entries={historyQuery.data?.entries}
              isLoading={historyQuery.isLoading}
              isError={historyQuery.isError}
            />
            <div className="space-y-3">
              {isNative && <ThemeToggleRow />}
              {isNative && <BiometricLockRow />}
              <Link
                to="/settings/wallet"
                className="block w-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 text-left text-gray-900 dark:text-white hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">Wallet</span>
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Link a Stellar address to receive on-chain cashback.
                </p>
              </Link>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  void (async () => {
                    await logout();
                    void navigate('/');
                  })();
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await requestOtp(email);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await verifyAndStore(email, otp);
      void navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4 native-auth-screen">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/loop-logo.svg" alt="Loop" className="h-8 mx-auto mb-4 dark:hidden" />
          <img
            src="/loop-logo-white.svg"
            alt="Loop"
            className="h-8 mx-auto mb-4 hidden dark:block"
          />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {step === 'email' ? 'Sign in to Loop' : 'Check your email'}
          </h1>
          {step === 'otp' && (
            <p className="text-gray-500 mt-2">We sent a 6-digit code to {email}</p>
          )}
        </div>

        {step === 'email' ? (
          <div className="space-y-4">
            {googleClientId !== null && googleClientId.length > 0 ? (
              <>
                <GoogleSignInButton
                  clientId={googleClientId}
                  onCredential={handleGoogleCredential}
                />
                <div className="relative flex items-center justify-center my-2">
                  <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-200 dark:bg-gray-800" />
                  <span className="relative bg-white dark:bg-gray-950 px-3 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    or
                  </span>
                </div>
              </>
            ) : null}
            <form
              onSubmit={(e) => {
                void handleEmailSubmit(e);
              }}
              className="space-y-4"
            >
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(v) => setEmail(v)}
                required
                label="Email address"
                // A2-1100: let password managers + iOS / Android auto-fill
                // the email from Keychain / Autofill. Matches the
                // onboarding signup form (signup-tail.tsx) which already
                // sets this.
                autoComplete="email"
              />
              {error !== null && <p className="text-red-500 text-sm">{error}</p>}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Sending…' : 'Send verification code'}
              </Button>
            </form>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              void handleOtpSubmit(e);
            }}
            className="space-y-4"
          >
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={otp}
              onChange={(v) => setOtp(v)}
              required
              autoFocus
              label="Verification code"
              // A2-1100: iOS surfaces the OTP from the notification
              // bar as a keyboard suggestion; Android Autofill does
              // the same via Google Messages. Matches the onboarding
              // form (signup-tail.tsx) which already sets this.
              autoComplete="one-time-code"
            />
            {error !== null && <p className="text-red-500 text-sm">{error}</p>}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Verifying…' : 'Verify'}
            </Button>
            <button
              type="button"
              className="w-full text-sm text-gray-500 underline"
              onClick={() => {
                // Clear OTP + error state alongside the step flip —
                // otherwise a user who typed a wrong code, saw an error,
                // then backed out to try another email would see the
                // OTP-step error leak onto the email form, and the
                // stale OTP buffer would be submitted alongside the
                // new email if they forgot to retype. Matches the
                // inline-auth handler in `PurchaseContainer`.
                setStep('email');
                setOtp('');
                setError(null);
              }}
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
