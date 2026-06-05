/**
 * Desktop onboarding — a split layout used at `lg+` widths on the
 * `/onboarding` route. The mobile multi-screen flow (`Onboarding`)
 * stays the experience on phones + native; this is the web-desktop
 * equivalent: a marketing slideshow on the left (with arrows), and
 * the email → verification-code capture on the right.
 *
 * Reuses `useOnboardingAuth` so the OTP send/verify behaviour is
 * identical to the mobile flow.
 */
import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router';
import { LoopLogo } from '~/components/ui/LoopLogo';
import { Input } from '~/components/ui/Input';
import { Button } from '~/components/ui/Button';
import { useOnboardingAuth } from './signup-tail';
import { TrustWelcome, TrustHowItWorks, TrustMerchants } from './screens-trust';
import { COPY } from './Onboarding';

// The same animated marketing screens the mobile flow uses (the
// count-up cashback card, the how-it-works panel, the brand tiles) —
// reused verbatim so desktop and mobile tell the identical story.
const SCREENS = [
  (active: boolean) => <TrustWelcome active={active} copy={COPY[1]} />,
  (active: boolean) => <TrustHowItWorks active={active} copy={COPY[2]} />,
  (active: boolean) => <TrustMerchants active={active} copy={COPY[3]} />,
];

function SlidePanel(): React.JSX.Element {
  const [i, setI] = useState(0);
  const go = useCallback((d: number) => setI((v) => (v + d + SCREENS.length) % SCREENS.length), []);

  // No autoplay — the user advances the slideshow with the arrows / dots.

  return (
    <div className="relative hidden lg:flex lg:w-1/2 flex-col overflow-hidden border-r border-line bg-surface-subtle">
      {/* The live onboarding screen. `key` remounts on change so the
          screen's enter animations (count-up, tile reveal) re-fire. */}
      <div key={i} className="flex flex-1 flex-col pt-12">
        {SCREENS[i]!(true)}
      </div>

      {/* Slideshow controls. */}
      <div className="relative flex items-center justify-between px-12 pb-10">
        <div className="flex gap-2">
          {SCREENS.map((_, idx) => (
            <span
              key={idx}
              className={`h-1.5 rounded-full transition-all ${idx === i ? 'w-6 bg-blue-600' : 'w-1.5 bg-ink/15'}`}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-line-strong bg-white text-ink-muted transition-colors hover:bg-gray-50 hover:text-ink"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-line-strong bg-white text-ink-muted transition-colors hover:bg-gray-50 hover:text-ink"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

interface OnboardingDesktopProps {
  onComplete?: () => void;
}

export function OnboardingDesktop({ onComplete }: OnboardingDesktopProps = {}): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const { sendingOtp, verifyingOtp, emailError, otpError, sendOtp, verify, clearErrors } =
    useOnboardingAuth();

  const handleEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (await sendOtp(email)) setStep('otp');
  };

  const handleOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (await verify(email, otp)) {
      if (onComplete) onComplete();
      else void navigate('/');
    }
  };

  return (
    <div className="flex min-h-screen">
      <SlidePanel />

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-surface px-8 py-12">
        <div className="w-full max-w-sm">
          <LoopLogo className="mb-8 h-8 w-auto text-ink lg:hidden" />
          {step === 'email' ? (
            <>
              <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
                Create your account
              </h1>
              <p className="mt-2 text-ink-muted">
                Enter your email and we’ll send you a verification code — no password needed.
              </p>
              <form onSubmit={(e) => void handleEmail(e)} className="mt-8 space-y-4">
                <Input
                  type="email"
                  label="Email address"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(v) => {
                    setEmail(v);
                    clearErrors();
                  }}
                  required
                  autoComplete="email"
                  autoFocus
                  {...(emailError !== null ? { error: emailError } : {})}
                />
                <Button type="submit" size="lg" className="w-full" loading={sendingOtp}>
                  Send verification code
                </Button>
              </form>
              <p className="mt-6 text-sm text-ink-muted">
                Already have an account?{' '}
                <Link to="/auth" className="font-medium text-blue-600 hover:text-blue-700">
                  Log in
                </Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
                Check your email
              </h1>
              <p className="mt-2 text-ink-muted">
                We sent a 6-digit code to <span className="font-medium text-ink">{email}</span>.
              </p>
              <form onSubmit={(e) => void handleOtp(e)} className="mt-8 space-y-4">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  label="Verification code"
                  placeholder="000000"
                  value={otp}
                  onChange={(v) => {
                    setOtp(v);
                    clearErrors();
                  }}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  {...(otpError !== null ? { error: otpError } : {})}
                />
                <Button type="submit" size="lg" className="w-full" loading={verifyingOtp}>
                  Verify &amp; continue
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setStep('email');
                    setOtp('');
                    clearErrors();
                  }}
                  className="w-full text-sm text-ink-muted hover:text-ink"
                >
                  Use a different email
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
