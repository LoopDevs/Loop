import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/auth';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useUiStore } from '~/stores/ui.store';
import type { ThemePreference } from '~/stores/ui.store';
import { Navbar } from '~/components/features/Navbar';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { checkBiometrics, authenticateWithBiometrics } from '~/native/biometrics';
import { isAppLockEnabled, setAppLockEnabled } from '~/native/app-lock';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Sign in — Loop' }];
}

type AuthStep = 'email' | 'otp';

function ThemeToggleRow(): React.JSX.Element {
  const { themePreference, setThemePreference } = useUiStore();

  const options: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: '\uD83D\uDCF1 System' },
    { value: 'light', label: '\u2600\uFE0F Light' },
    { value: 'dark', label: '\uD83C\uDF19 Dark' },
  ];

  const current = options.find((o) => o.value === themePreference) ?? options[0]!;

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
      <span className="text-gray-500 dark:text-gray-400">{current.label}</span>
    </button>
  );
}

function BiometricLockRow(): React.JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [biometryType, setBiometryType] = useState<string>('');

  useEffect(() => {
    void (async () => {
      const result = await checkBiometrics();
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
        setEnabled(lockEnabled);
      }
    })();
  }, []);

  if (!available) return null;

  const handleToggle = async (): Promise<void> => {
    if (!enabled) {
      const ok = await authenticateWithBiometrics(`Enable ${biometryType}`);
      if (ok) {
        await setAppLockEnabled(true);
        setEnabled(true);
      }
    } else {
      await setAppLockEnabled(false);
      setEnabled(false);
    }
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
    logout,
  } = useAuth();
  const { isNative } = useNativePlatform();

  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If authenticated, show account view
  if (isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        {!isNative && <Navbar />}
        <div className="flex items-center justify-center min-h-[80vh] px-4">
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
      </div>
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/loop-logo.svg" alt="Loop" className="h-10 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {step === 'email' ? 'Sign in to Loop' : 'Check your email'}
          </h1>
          {step === 'otp' && (
            <p className="text-gray-500 mt-2">We sent a 6-digit code to {email}</p>
          )}
        </div>

        {step === 'email' ? (
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
              autoFocus
              label="Email address"
            />
            {error !== null && <p className="text-red-500 text-sm">{error}</p>}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Sending…' : 'Send verification code'}
            </Button>
          </form>
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
              onClick={() => setStep('email')}
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
