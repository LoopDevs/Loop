import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/auth';
import { useAuth } from '~/hooks/use-auth';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Sign in — Loop' }];
}

type AuthStep = 'email' | 'otp';

export function ErrorBoundary(): React.JSX.Element {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Something went wrong</h1>
        <p className="text-gray-600 dark:text-gray-300 mb-6">We couldn&apos;t load the sign-in page.</p>
        <a href="/auth" className="text-blue-600 underline">Try again</a>
      </div>
    </div>
  );
}

export default function AuthRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { requestOtp, verifyOtp: verifyAndStore } = useAuth();

  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await requestOtp(email);
      setStep('otp');
    } catch {
      setError('Failed to send verification code. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const success = await verifyAndStore(email, otp);
      if (success) {
        void navigate('/');
      } else {
        setError('Incorrect code. Please try again.');
      }
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
          <form onSubmit={(e) => { void handleEmailSubmit(e); }} className="space-y-4">
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
          <form onSubmit={(e) => { void handleOtpSubmit(e); }} className="space-y-4">
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
