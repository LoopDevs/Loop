import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { checkBiometrics } from '~/native/biometrics';
import type { BiometricResult } from '~/native/biometrics';
import { setHomeCurrency } from '~/services/user';
import { useAppConfig } from '~/hooks/use-app-config';
import { readCountryCookie } from '~/i18n/locale';
import { isValidEmail } from '~/utils/email';
import { ApiException, isSupportedCountryCode } from '@loop/shared';
import { Dots, useReducedMotion } from './atoms';
import { TrustWelcome, TrustHowItWorks, TrustMerchants } from './screens-trust';
import { EmailEntry, OtpEntry, WelcomeIn, useOnboardingAuth } from './signup-tail';
import { BiometricSetup } from './screen-biometric';
import {
  CurrencyPickerScreen,
  guessHomeCurrency,
  homeCurrencyForCountry,
  type HomeCurrency,
} from './screen-currency';
import { WalletIntroScreen } from './screen-wallet-intro';

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
// Steps 1-3 (the marketing trust screens, rendered as steps 0-2 by
// `renderStep`) are Phase-2 (cashback / bank-transfer) by default.
// U-2 / UX-01 (docs/ux-pass-2026-07-09.md): these were the last
// screens in the app still making that promise unconditionally under
// `LOOP_PHASE_1_ONLY=true` — every other surface already branches on
// `phase1Only` (see home.tsx's hero copy). The `onboarding:copyPhase1.*`
// catalogue keys (see `getOnboardingCopy()` below) override just those
// three entries with discount-flavoured copy when the flag is set. Steps
// 4-9 are phase-neutral or already skipped outright by the effect below,
// so they don't need a split.
//
// ADR 043 (B-6): the literal copy bank that used to live here (`COPY` +
// `PHASE1_TRUST_COPY`) is now the `onboarding:copy.*` / `onboarding:copyPhase1.*`
// catalogue (`~/i18n/locales/en/onboarding.json`); `getOnboardingCopy()`
// below builds the same `Record<1..9, ScreenCopy>` shape via `t()` lookups
// instead of an object-literal merge.
export function getOnboardingCopy(
  t: TFunction<'onboarding'>,
  phase1Only: boolean,
): Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, ScreenCopy> {
  const copy: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, ScreenCopy> = {
    1: { eyebrow: t('copy.1.eyebrow'), title: t('copy.1.title'), sub: t('copy.1.sub') },
    2: { eyebrow: t('copy.2.eyebrow'), title: t('copy.2.title'), sub: t('copy.2.sub') },
    3: { eyebrow: t('copy.3.eyebrow'), title: t('copy.3.title'), sub: t('copy.3.sub') },
    4: { title: t('copy.4.title'), sub: t('copy.4.sub') },
    5: { title: t('copy.5.title'), sub: t('copy.5.sub') },
    6: { eyebrow: t('copy.6.eyebrow'), title: t('copy.6.title'), sub: t('copy.6.sub') },
    7: { title: t('copy.7.title'), sub: t('copy.7.sub') },
    8: { eyebrow: t('copy.8.eyebrow'), title: t('copy.8.title'), sub: t('copy.8.sub') },
    9: { title: t('copy.9.title'), sub: t('copy.9.sub') },
  };
  if (!phase1Only) return copy;
  return {
    ...copy,
    1: {
      eyebrow: t('copyPhase1.1.eyebrow'),
      title: t('copyPhase1.1.title'),
      sub: t('copyPhase1.1.sub'),
    },
    2: {
      eyebrow: t('copyPhase1.2.eyebrow'),
      title: t('copyPhase1.2.title'),
      sub: t('copyPhase1.2.sub'),
    },
    3: {
      eyebrow: t('copyPhase1.3.eyebrow'),
      title: t('copyPhase1.3.title'),
      sub: t('copyPhase1.3.sub'),
    },
  };
}

const TOTAL_STEPS = 9;

/**
 * First-launch onboarding flow. Nine screens:
 *   0 Welcome · 1 How it works · 2 Brands · 3 Email · 4 OTP
 *   5 Currency · 6 Biometrics · 7 Wallet intro · 8 Welcome-in
 *
 * Steps 0-2 are illustrative (no state). Step 3 collects email and
 * fires `requestOtp` on CTA. Step 4 collects the 6-digit code and
 * auto-submits on the final keystroke via `verifyOtp`. Step 5 picks
 * home currency (ADR 015). Step 6 enables biometric unlock (skips
 * on unsupported devices). Step 7 explains Loop's stablecoin payout
 * story (ADR 015) and offers a shortcut into /settings/wallet for
 * users who want to link a Stellar address immediately. Step 8 is
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
  const { config } = useAppConfig();
  const { t } = useTranslation('onboarding');
  // FE-53 (a11y): gate the inter-step slide animation on the OS
  // reduced-motion preference (WCAG 2.1 §2.3.3).
  const reduced = useReducedMotion();
  // Tranche 1 (MVP) launch: skip steps 5 (CurrencyPicker — needs
  // multi-currency cashback) and 7 (WalletIntro — needs the
  // Stellar passkey wallet that ships in Tranche 2). Auto-advance
  // when we render those indices so users see only steps 0-4, 6, 8.
  const phase1Only = config.phase1Only;
  // U-2 / UX-01: steps 0-2 (the marketing trust screens) show
  // discount-flavoured copy in Phase 1 instead of the default
  // cashback/bank-transfer copy — see `getOnboardingCopy()`. Named
  // `stepCopy` (not `copy`) to stay unambiguous next to the `copy`
  // prop every screen component below takes.
  const stepCopy = getOnboardingCopy(t, phase1Only);
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
    deviceIsSecure: false,
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
  // First guess from the visitor's country (ADR 034). Precedence: the routed
  // URL country (canonical) → the saved country cookie (the onboarding link may
  // be unprefixed) → the browser-locale default above. Skipped once the user
  // taps a currency.
  const params = useParams();
  const currencyTouched = useRef(false);
  useEffect(() => {
    if (currencyTouched.current) return;
    const country =
      (isSupportedCountryCode(params.country) ? params.country : null) ?? readCountryCookie();
    if (country) setCurrency(homeCurrencyForCountry(country));
  }, [params.country]);
  const handlePickCurrency = useCallback((code: HomeCurrency) => {
    currencyTouched.current = true;
    setCurrency(code);
  }, []);
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
  const emailValid = isValidEmail(email);
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
  //
  // "Enable Face ID" is an Apple product name — never translated, same
  // convention as auth.tsx's biometric-label handling.
  const biometricCtaLabel = !biometricsChecked
    ? t('cta.checking')
    : !biometrics.available
      ? t('cta.continue')
      : 'Enable Face ID';

  // CTA label + handler + enabled flag per step. Centralised so the
  // footer doesn't have to branch on step internally.
  const stepCta: Array<{ label: string; act: () => void; enabled: boolean }> = [
    { label: t('cta.getStarted'), act: next, enabled: true },
    { label: t('cta.continue'), act: next, enabled: true },
    { label: t('cta.continue'), act: goToEmail, enabled: true },
    {
      label: sendingOtp ? t('cta.sending') : t('cta.sendCode'),
      act: () => void handleEmailCta(),
      enabled: emailValid && !sendingOtp,
    },
    {
      label: verifyingOtp ? t('cta.verifying') : t('cta.verify'),
      act: () => void handleOtpVerify(),
      enabled: otpValid && !verifyingOtp,
    },
    {
      label: savingCurrency ? t('cta.saving') : t('cta.continue'),
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
    // Step 7: wallet intro — informational. CTA always advances;
    // the "Link a wallet now" button inside the screen handles the
    // early-exit case by navigating to /settings/wallet.
    { label: t('cta.continue'), act: next, enabled: true },
    { label: t('cta.openLoop'), act: handleFinish, enabled: true },
  ];

  // Re-clear error messages when the user advances past a network
  // step — otherwise a prior 429/400 would linger in the UI if they
  // re-entered the step via Back.
  useEffect(() => {
    if (step !== 3 && step !== 4) clearErrors();
    if (step !== 5) setCurrencyError(null);
  }, [step, clearErrors]);

  // Tranche 1 auto-skip for the cashback-related steps. Done in
  // an effect so React commits the intermediate render before we
  // setStep — avoids "Cannot update during render" warnings.
  //
  // Direction-aware (comprehensive-audit 2026-06-11, P10): the skip
  // must follow the user's travel direction. The previous version
  // always skipped forward, so pressing Back from step 6 landed on
  // skipped step 5 and immediately bounced forward to 6 again —
  // Back was a no-op trap. Track where we came from and skip
  // backward when the user is navigating backward.
  const prevStepRef = useRef(0);
  useEffect(() => {
    const cameFrom = prevStepRef.current;
    prevStepRef.current = step;
    if (!phase1Only) return;
    if (step === 5 || step === 7) {
      const movingBack = cameFrom > step;
      setStep((s) => (movingBack ? Math.max(0, s - 1) : Math.min(TOTAL_STEPS - 1, s + 1)));
    }
  }, [step, phase1Only]);

  const currentCta = stepCta[step]!;

  const renderStep = (idx: number, active: boolean): React.JSX.Element | null => {
    if (idx === 0)
      return <TrustWelcome active={active} copy={stepCopy[1]} phase1Only={phase1Only} />;
    if (idx === 1)
      return <TrustHowItWorks active={active} copy={stepCopy[2]} phase1Only={phase1Only} />;
    if (idx === 2) return <TrustMerchants active={active} copy={stepCopy[3]} />;
    if (idx === 3)
      return (
        <EmailEntry
          active={active}
          copy={stepCopy[4]}
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
          copy={stepCopy[5]}
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
          copy={stepCopy[6]}
          selected={currency}
          onSelect={handlePickCurrency}
          error={currencyError}
        />
      );
    if (idx === 6)
      return (
        <BiometricSetup
          active={active}
          copy={stepCopy[7]}
          available={biometricsChecked ? biometrics.available : null}
          onEnabled={next}
          triggerRef={biometricTriggerRef}
        />
      );
    if (idx === 7)
      return (
        <WalletIntroScreen
          active={active}
          copy={stepCopy[8]}
          homeCurrency={currency}
          onLinkWallet={() => {
            // Leave onboarding and drop into the real trustline flow.
            // The user is already authenticated (verify-otp ran at
            // step 4), so /settings/wallet is reachable.
            void navigate('/settings/wallet');
          }}
        />
      );
    if (idx === 8) return <WelcomeIn active={active} copy={stepCopy[9]} />;
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
                transition: reduced
                  ? 'none'
                  : 'opacity 320ms cubic-bezier(0.4,0,0.2,1), transform 320ms cubic-bezier(0.4,0,0.2,1)',
                pointerEvents: state === 'active' ? 'auto' : 'none',
              }}
              aria-hidden={state !== 'active'}
              // A11Y-019 / CF-35: `inert` removes inactive slides from the
              // tab order AND from AT — previously the email/OTP inputs of
              // hidden slides stayed Tab-focusable inside an `aria-hidden`
              // subtree (an ARIA violation). `inert` closes both gaps.
              inert={state !== 'active'}
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
          className="w-full h-[54px] rounded-2xl border-0 text-[17px] font-semibold cursor-pointer disabled:cursor-not-allowed bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-white active:scale-[0.98] transition-[transform,background-color] motion-reduce:transition-none motion-reduce:active:scale-100"
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
            {t('cta.back')}
          </button>
        ) : step === 0 ? (
          <button
            type="button"
            onClick={() => setStep(3)}
            className="w-full h-10 bg-transparent border-0 text-[15px] font-medium text-gray-500 dark:text-gray-400 cursor-pointer"
          >
            {t('cta.alreadyHaveAccount')}
          </button>
        ) : (
          <div className="h-10" />
        )}
      </div>
    </div>
  );
}
