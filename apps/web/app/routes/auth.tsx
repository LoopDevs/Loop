import { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/auth';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAppConfig } from '~/hooks/use-app-config';
import { useUiStore } from '~/stores/ui.store';
import type { ThemePreference } from '~/stores/ui.store';
import { Navbar } from '~/components/features/Navbar';
import { PageHeader } from '~/components/ui/PageHeader';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { GoogleSignInButton } from '~/components/features/auth/GoogleSignInButton';
import { checkBiometrics, authenticateWithBiometrics } from '~/native/biometrics';
import { isAppLockEnabled, setAppLockEnabled } from '~/native/app-lock';

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
            <p className="text-gray-500 dark:text-gray-400 mb-8">{userEmail}</p>
            <div className="space-y-3">
              {isNative && <ThemeToggleRow />}
              {isNative && <BiometricLockRow />}
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
