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
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { LoopLogo } from '~/components/ui/LoopLogo';
import { BackToSite } from '~/components/ui/BackToSite';
import { Input } from '~/components/ui/Input';
import { Button } from '~/components/ui/Button';
import { useAppConfig } from '~/hooks/use-app-config';
import { useOnboardingAuth } from './signup-tail';
import { TrustWelcome, TrustHowItWorks, TrustMerchants } from './screens-trust';
import { getOnboardingCopy } from './Onboarding';

// The same animated marketing screens the mobile flow uses (the
// count-up cashback card, the how-it-works panel, the brand tiles) —
// reused verbatim so desktop and mobile tell the identical story.
// U-2 / UX-01 (docs/ux-pass-2026-07-09.md): `phase1Only` threads
// through to both `getOnboardingCopy()` (the COPY[1]/[2]/[3] text)
// and the two screens' own hardcoded card labels, mirroring the
// native `Onboarding.tsx` flow so the two surfaces never drift.
function buildScreens(
  t: TFunction<'onboarding'>,
  phase1Only: boolean,
): ((active: boolean) => React.JSX.Element)[] {
  const copy = getOnboardingCopy(t, phase1Only);
  return [
    (active: boolean) => <TrustWelcome active={active} copy={copy[1]} phase1Only={phase1Only} />,
    (active: boolean) => <TrustHowItWorks active={active} copy={copy[2]} phase1Only={phase1Only} />,
    (active: boolean) => <TrustMerchants active={active} copy={copy[3]} />,
  ];
}

function SlidePanel(): React.JSX.Element {
  const { config } = useAppConfig();
  const { t } = useTranslation('onboarding');
  const SCREENS = useMemo(() => buildScreens(t, config.phase1Only), [t, config.phase1Only]);
  const [i, setI] = useState(0);
  const go = useCallback(
    (d: number) => setI((v) => (v + d + SCREENS.length) % SCREENS.length),
    [SCREENS.length],
  );

  // No autoplay — the user advances the slideshow with the arrows / dots.

  return (
    <div className="relative hidden lg:flex lg:w-1/2 flex-col overflow-hidden border-r border-line bg-surface-subtle">
      {/* The live onboarding screen, capped at 600px and centred. `key`
          remounts on change so the screen's enter animations (count-up,
          tile reveal) re-fire. */}
      <div className="flex flex-1 flex-col items-center pt-12">
        <div key={i} className="flex w-full max-w-[600px] flex-1 flex-col">
          {SCREENS[i]!(true)}
        </div>
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
            aria-label={t('desktop.slideshow.previous')}
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
            aria-label={t('desktop.slideshow.next')}
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

// UX-07: cooldown after tapping "Resend code," mirroring the backend's
// `POST /api/auth/request-otp` limit (5/min — AGENTS.md middleware stack).
// 30s keeps every resend comfortably under that budget while still giving
// clear, immediate feedback that the tap did something.
const RESEND_COOLDOWN_SECONDS = 30;

export function OnboardingDesktop({ onComplete }: OnboardingDesktopProps = {}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const navigate = useNavigate();
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  // A single interval, armed once per resend tap (not re-created every
  // tick) and cleared on unmount / when the user backs out to re-enter
  // an email — see `stopCooldown` below.
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { sendingOtp, verifyingOtp, emailError, otpError, sendOtp, verify, clearErrors } =
    useOnboardingAuth();

  const stopCooldown = useCallback((): void => {
    if (cooldownIntervalRef.current !== null) {
      clearInterval(cooldownIntervalRef.current);
      cooldownIntervalRef.current = null;
    }
  }, []);

  useEffect(() => stopCooldown, [stopCooldown]);

  const startCooldown = useCallback((): void => {
    stopCooldown();
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    cooldownIntervalRef.current = setInterval(() => {
      setResendCooldown((s) => {
        if (s <= 1) {
          stopCooldown();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, [stopCooldown]);

  const handleEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // No cooldown on the initial send — the code hasn't been resent yet,
    // so the OTP step opens with "Resend code" immediately available.
    if (await sendOtp(email)) setStep('otp');
  };

  const handleOtp = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (await verify(email, otp)) {
      if (onComplete) onComplete();
      else void navigate('/');
    }
  };

  const handleResend = async (): Promise<void> => {
    if (resendCooldown > 0 || sendingOtp) return;
    if (await sendOtp(email)) startCooldown();
  };

  return (
    <div className="flex min-h-screen">
      <SlidePanel />

      {/* Form panel — A11Y-010 / CF-35: <main> landmark + skip-link target. */}
      <main id="main" className="flex flex-1 items-center justify-center bg-surface px-8 py-12">
        <div className="w-full max-w-sm">
          <BackToSite />
          <LoopLogo className="mb-6 h-8 w-auto text-ink lg:hidden" />
          {step === 'email' ? (
            <>
              <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
                {t('desktop.emailStep.heading')}
              </h1>
              <p className="mt-2 text-ink-muted">{t('desktop.emailStep.sub')}</p>
              <form onSubmit={(e) => void handleEmail(e)} className="mt-8">
                <Input
                  type="email"
                  label={t('desktop.emailStep.emailLabel')}
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onChange={(v) => {
                    setEmail(v);
                    clearErrors();
                  }}
                  required
                  autoComplete="email"
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- ADR 042: deliberate UX — this is the sole input on a step that just became active after an explicit user action (submit email / advance a wizard step), not an unexpected focus jump. eslint-plugin-jsx-a11y blanket-disallows autoFocus; WCAG does not. Tracked: docs/readiness-backlog-2026-07-03.md B-2.
                  autoFocus
                  {...(emailError !== null ? { error: emailError } : {})}
                />
                <p className="mt-2.5 flex items-center gap-1.5 text-sm text-ink-muted">
                  <svg
                    className="h-3.5 w-3.5 flex-shrink-0 text-blue-500"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 21s-7.5-4.9-10-9.2C.4 8.6 2 5 5.5 5c2 0 3.4 1.1 4.5 2.6C11.1 6.1 12.5 5 14.5 5 18 5 19.6 8.6 22 11.8 19.5 16.1 12 21 12 21z" />
                  </svg>
                  {t('trust.emailPrivacy')}
                </p>
                <Button type="submit" size="lg" className="mt-4 w-full" loading={sendingOtp}>
                  {t('desktop.emailStep.sendButton')}
                </Button>
              </form>
              <p className="mt-6 text-sm text-ink-muted">
                {t('desktop.emailStep.alreadyHaveAccountPrefix')}
                <Link to="/auth" className="font-medium text-blue-600 hover:text-blue-700">
                  {t('desktop.emailStep.logIn')}
                </Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
                {t('desktop.otpStep.heading')}
              </h1>
              <p className="mt-2 text-ink-muted">
                {t('desktop.otpStep.subPrefix')}
                <span className="font-medium text-ink">{email}</span>
                {t('desktop.otpStep.subSuffix')}
              </p>
              <form onSubmit={(e) => void handleOtp(e)} className="mt-8 space-y-4">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  label={t('desktop.otpStep.otpLabel')}
                  placeholder="000000"
                  value={otp}
                  onChange={(v) => {
                    setOtp(v);
                    clearErrors();
                  }}
                  required
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- ADR 042: deliberate UX — this is the sole input on a step that just became active after an explicit user action (submit email / advance a wizard step), not an unexpected focus jump. eslint-plugin-jsx-a11y blanket-disallows autoFocus; WCAG does not. Tracked: docs/readiness-backlog-2026-07-03.md B-2.
                  autoFocus
                  autoComplete="one-time-code"
                  {...(otpError !== null ? { error: otpError } : {})}
                />
                <Button type="submit" size="lg" className="w-full" loading={verifyingOtp}>
                  {t('desktop.otpStep.verifyButton')}
                </Button>
                {/* UX-07: explicit resend, mirroring the native flow's
                    "Resend code" (signup-tail.tsx's OtpEntry). Disabled
                    during the post-send cooldown so it can't be used to
                    hammer the 5/min request-otp rate limit. */}
                <button
                  type="button"
                  onClick={() => void handleResend()}
                  disabled={resendCooldown > 0 || sendingOtp}
                  className="w-full text-sm text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resendCooldown > 0
                    ? t('resend.in', { seconds: resendCooldown })
                    : t('resend.code')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    stopCooldown();
                    setResendCooldown(0);
                    setStep('email');
                    setOtp('');
                    clearErrors();
                  }}
                  className="w-full text-sm text-ink-muted hover:text-ink"
                >
                  {t('desktop.otpStep.useDifferentEmail')}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
