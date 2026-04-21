import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { checkBiometrics } from '~/native/biometrics';
import type { BiometricResult } from '~/native/biometrics';
import { setHomeCurrency } from '~/services/user';
import { ApiException } from '@loop/shared';
import { Dots } from './atoms';
import { TrustWelcome, TrustHowItWorks, TrustMerchants } from './screens-trust';
import { EmailEntry, OtpEntry, WelcomeIn, useOnboardingAuth } from './signup-tail';
import { BiometricSetup } from './screen-biometric';
import { CurrencyPickerScreen, guessHomeCurrency, type HomeCurrency } from './screen-currency';

interface ScreenCopy {
  eyebrow?: string;
  title: string;
  sub: string;
}

// Copy bank. Matches the design's "trust" flavour but with phone →
// email copy swapped in (Loop auth is email-OTP, not phone). Bank
// linking is intentionally out of scope for this implementation —
// we end on Welcome-in right after OTP verify. Step 6 is an
// optional biometric-enable step between OTP and Welcome-in; it
// self-skips on devices without biometrics.
const COPY: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, ScreenCopy> = {
  1: {
    eyebrow: 'Welcome to Loop',
    title: 'Shop. Save.\nRepeat.',
    sub: 'The smart way to pay — earn cashback on every purchase, paid by instant bank transfer.',
  },
  2: {
    eyebrow: 'How it works',
    title: 'Buy gift cards, get cash back.',
    sub: 'When you shop at stores you already love, buy a Loop gift card first. You get up to 7% back instantly.',
  },
  3: {
    eyebrow: 'Where it works',
    title: '500+ brands you\u2019ll actually use.',
    sub: 'Groceries, gas, dining, everyday runs. Your cashback adds up fast.',
  },
  4: {
    title: 'What\u2019s your email?',
    sub: 'We\u2019ll send you a 6-digit code to verify. Your email is never shared.',
  },
  5: { title: 'Check your inbox', sub: 'We sent a 6-digit code to' },
  6: {
    eyebrow: 'Your region',
    title: 'Pick your currency.',
    sub: 'Prices, purchases and cashback all land in this currency. You can change it later with our support team.',
  },
  7: {
    title: 'One-tap sign in',
    sub: 'Use biometrics to unlock Loop and confirm purchases. Your biometric data never leaves the device.',
  },
  8: {
    title: 'You\u2019re in.',
    sub: 'Your Loop account is ready. Start earning on your first purchase.',
  },
};

const TOTAL_STEPS = 8;

/**
 * First-launch onboarding flow. Six screens:
 *   0 Welcome · 1 How it works · 2 Brands · 3 Email · 4 OTP · 5 Welcome-in
 *
 * Steps 0-2 are illustrative (no state). Step 3 collects email and
 * fires `requestOtp` on CTA. Step 4 collects the 6-digit code and
 * auto-submits on the final keystroke via `verifyOtp`. Step 5 is
 * the payoff — "Open Loop" returns the user to the home route,
 * authenticated (auth store is hydrated by the verify step).
 *
 * The container lives inside the `/onboarding` route and owns the
 * full-bleed layout; parent routes should not render the Navbar
 * or tab bar on this path (route-level concern, handled by the
 * route module).
 */
interface OnboardingProps {
  /**
   * Called when the user taps "Open Loop" on the final screen.
   * Supplied by the native root-level first-launch flow to flip the
   * "onboarded" flag and let the router take over. Web callers can
   * omit this — we fall back to navigating to `/`.
   */
  onComplete?: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps = {}): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  // Owned at this level so the Brands → Email CTA can call
  // `.focus()` synchronously (within the user gesture) and have
  // Android's WebView raise the soft keyboard — a useEffect-driven
  // focus runs after commit and Android treats it as non-gesture.
  const emailInputRef = useRef<HTMLInputElement | null>(null);

  // Biometric probe — fires once at container mount so the label
  // ("Enable Face ID" vs "Enable fingerprint") and the unavailable-
  // -skip path are ready by the time the user lands on step 5.
  const [biometrics, setBiometrics] = useState<BiometricResult>({
    available: false,
    biometryType: 'none',
  });
  const [biometricsChecked, setBiometricsChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void checkBiometrics().then((r) => {
      if (cancelled) return;
      setBiometrics(r);
      setBiometricsChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const biometricTriggerRef = useRef<(() => void) | null>(null);

  const { sendingOtp, verifyingOtp, emailError, otpError, sendOtp, verify, clearErrors } =
    useOnboardingAuth();

  // Currency step (ADR 015). Default from the browser locale, but
  // the user picks explicitly before the CTA fires. `savingCurrency`
  // drives the CTA label; `currencyError` renders inline.
  const [currency, setCurrency] = useState<HomeCurrency>(() =>
    guessHomeCurrency(typeof navigator !== 'undefined' ? navigator.language : undefined),
  );
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [currencyError, setCurrencyError] = useState<string | null>(null);

  const next = useCallback(() => setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1)), []);
  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  // Keyboard nav — arrow keys advance / go back, except when the
  // user is typing into an input (so arrow-key caret motion in the
  // email or OTP fields keeps working).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back]);

  // Swipe nav — horizontal swipes move between steps, with a
  // vertical-tolerance guard so scrolling the Brands grid vertically
  // doesn't accidentally flip the screen.
  const touchRef = useRef({ x: 0, y: 0 });
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>): void => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>): void => {
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchRef.current.x;
    const dy = t.clientY - touchRef.current.y;
    if (Math.abs(dx) > 40 && Math.abs(dy) < 60) {
      if (dx < 0) next();
      else back();
    }
  };

  // --- step-specific CTA wiring ------------------------------------
  const emailValid = /.+@.+\..+/.test(email);
  const otpValid = otp.length === 6;

  const handleEmailCta = async (): Promise<void> => {
    if (!emailValid || sendingOtp) return;
    const ok = await sendOtp(email);
    if (ok) {
      setOtp('');
      next();
    }
  };

  const handleOtpVerify = async (code?: string): Promise<void> => {
    // Prefer the value passed in from the OTP-entry auto-submit
    // path — the parent state hasn't committed the 6th digit at
    // that moment, so relying on `otp` here would short-circuit
    // on the length guard. CTA-tap callers (without an arg) fall
    // through to the current state.
    const value = code ?? otp;
    if (value.length !== 6 || verifyingOtp) return;
    const ok = await verify(email, value);
    if (ok) next();
    else setOtp('');
  };

  const handleResend = (): void => {
    if (sendingOtp) return;
    void sendOtp(email);
  };

  const handleCurrencyCta = async (): Promise<void> => {
    if (savingCurrency) return;
    setSavingCurrency(true);
    setCurrencyError(null);
    try {
      await setHomeCurrency(currency);
      next();
    } catch (err) {
      const message =
        err instanceof ApiException
          ? err.message
          : "Couldn't save your currency — check your connection and try again.";
      setCurrencyError(message);
    } finally {
      setSavingCurrency(false);
    }
  };

  const handleFinish = (): void => {
    if (onComplete !== undefined) {
      onComplete();
      return;
    }
    void navigate('/', { replace: true });
  };

  // Brands → Email transition needs to focus the email input inside
  // the click gesture so Android's WebView raises the keyboard. The
  // EmailEntry screen is pre-mounted (all screens render with
  // opacity), so the ref is valid before the state change commits.
  const goToEmail = (): void => {
    next();
    emailInputRef.current?.focus();
  };

  // CTA label for the biometric step. Always "Enable Face ID" so
  // the onboarding visual identity is consistent; the underlying
  // `authenticateWithBiometrics` call still binds to whatever the
  // device has (fingerprint on most Android, Face ID on iPhone),
  // so the OS-level prompt is correct. When biometrics aren't
  // available, flip to "Continue" since the screen auto-skips.
  const biometricCtaLabel = !biometricsChecked
    ? 'Checking\u2026'
    : !biometrics.available
      ? 'Continue'
      : 'Enable Face ID';

  // CTA label + handler + enabled flag per step. Centralised so the
  // footer doesn't have to branch on step internally.
  const stepCta: Array<{ label: string; act: () => void; enabled: boolean }> = [
    { label: 'Get started', act: next, enabled: true },
    { label: 'Continue', act: next, enabled: true },
    { label: 'Continue', act: goToEmail, enabled: true },
    {
      label: sendingOtp ? 'Sending…' : 'Send code',
      act: () => void handleEmailCta(),
      enabled: emailValid && !sendingOtp,
    },
    {
      label: verifyingOtp ? 'Verifying…' : 'Verify',
      act: () => void handleOtpVerify(),
      enabled: otpValid && !verifyingOtp,
    },
    {
      label: savingCurrency ? 'Saving…' : 'Continue',
      act: () => void handleCurrencyCta(),
      enabled: !savingCurrency,
    },
    {
      label: biometricCtaLabel,
      // When biometrics are available, hand off to the screen's
      // registered trigger (which fires the real prompt). When
      // unavailable, the CTA just advances — the screen also
      // self-skips from the useEffect, this is a belt-and-braces
      // fallback for users who tap faster than the skip timer.
      act: () => {
        if (!biometrics.available) {
          next();
          return;
        }
        biometricTriggerRef.current?.();
      },
      enabled: biometricsChecked,
    },
    { label: 'Open Loop', act: handleFinish, enabled: true },
  ];

  // Re-clear error messages when the user advances past a network
  // step — otherwise a prior 429/400 would linger in the UI if they
  // re-entered the step via Back.
  useEffect(() => {
    if (step !== 3 && step !== 4) clearErrors();
    if (step !== 5) setCurrencyError(null);
  }, [step, clearErrors]);

  const currentCta = stepCta[step]!;

  const renderStep = (idx: number, active: boolean): React.JSX.Element | null => {
    if (idx === 0) return <TrustWelcome active={active} copy={COPY[1]} />;
    if (idx === 1) return <TrustHowItWorks active={active} copy={COPY[2]} />;
    if (idx === 2) return <TrustMerchants active={active} copy={COPY[3]} />;
    if (idx === 3)
      return (
        <EmailEntry
          active={active}
          copy={COPY[4]}
          email={email}
          setEmail={setEmail}
          error={emailError}
          inputRef={emailInputRef}
        />
      );
    if (idx === 4)
      return (
        <OtpEntry
          active={active}
          copy={COPY[5]}
          email={email}
          otp={otp}
          setOtp={setOtp}
          error={otpError}
          onResend={handleResend}
          onVerified={(code) => void handleOtpVerify(code)}
        />
      );
    if (idx === 5)
      return (
        <CurrencyPickerScreen
          active={active}
          copy={COPY[6]}
          selected={currency}
          onSelect={setCurrency}
          error={currencyError}
        />
      );
    if (idx === 6)
      return (
        <BiometricSetup
          active={active}
          copy={COPY[7]}
          available={biometricsChecked ? biometrics.available : null}
          onEnabled={next}
          triggerRef={biometricTriggerRef}
        />
      );
    if (idx === 7) return <WelcomeIn active={active} copy={COPY[8]} />;
    return null;
  };

  return (
    <div
      className="fixed inset-0 flex flex-col bg-gray-50 dark:bg-gray-950 text-gray-950 dark:text-white"
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <Dots active={Math.min(step, TOTAL_STEPS - 1)} total={TOTAL_STEPS} />

      <div className="flex-1 relative overflow-hidden">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => {
          const state = i === step ? 'active' : i < step ? 'prev' : 'next';
          return (
            <div
              key={i}
              className="absolute inset-0 flex flex-col pb-[112px]"
              style={{
                opacity: state === 'active' ? 1 : 0,
                transform:
                  state === 'active'
                    ? 'translateX(0)'
                    : state === 'prev'
                      ? 'translateX(-40px)'
                      : 'translateX(40px)',
                transition:
                  'opacity 320ms cubic-bezier(0.4,0,0.2,1), transform 320ms cubic-bezier(0.4,0,0.2,1)',
                pointerEvents: state === 'active' ? 'auto' : 'none',
              }}
              aria-hidden={state !== 'active'}
            >
              {renderStep(i, i === step)}
            </div>
          );
        })}
      </div>

      <div
        className="absolute left-0 right-0 bottom-0 flex flex-col gap-2 px-6 pt-4 bg-gray-50 dark:bg-gray-950"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 16px), 28px)' }}
      >
        <button
          type="button"
          onClick={currentCta.act}
          disabled={!currentCta.enabled}
          className="w-full h-[54px] rounded-2xl border-0 text-[17px] font-semibold cursor-pointer disabled:cursor-not-allowed bg-gray-950 text-white dark:bg-white dark:text-gray-950 disabled:bg-gray-300 disabled:text-white dark:disabled:bg-gray-700 dark:disabled:text-gray-400 active:scale-[0.98] transition-transform"
          style={{ letterSpacing: '-0.01em' }}
        >
          {currentCta.label}
        </button>
        {step > 0 && step < TOTAL_STEPS - 1 ? (
          <button
            type="button"
            onClick={back}
            className="w-full h-10 bg-transparent border-0 text-[15px] font-medium text-gray-500 dark:text-gray-400 cursor-pointer"
          >
            Back
          </button>
        ) : step === 0 ? (
          <button
            type="button"
            onClick={() => setStep(3)}
            className="w-full h-10 bg-transparent border-0 text-[15px] font-medium text-gray-500 dark:text-gray-400 cursor-pointer"
          >
            I already have an account
          </button>
        ) : (
          <div className="h-10" />
        )}
      </div>
    </div>
  );
}
