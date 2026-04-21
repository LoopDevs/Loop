import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '~/stores/auth.store';
import { requestOtp, verifyOtp } from '~/services/auth';
import { readClipboard } from '~/native/clipboard';
import { friendlyError } from '~/utils/error-messages';

interface TailCopy {
  title: string;
  sub: string;
}

interface EmailEntryProps {
  active: boolean;
  copy: TailCopy;
  email: string;
  setEmail: (v: string) => void;
  error: string | null;
  /**
   * Parent-owned ref to the email <input>. Lifting it up lets the
   * outer Onboarding container call `.focus()` synchronously from
   * the Brands → Email CTA click, so Android's WebView raises the
   * soft keyboard (a useEffect-driven focus fires outside the
   * gesture and Android treats that as a no-op).
   */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Email entry — swaps in for the design's phone-entry screen since
 * the real Loop auth takes an email. The visual treatment matches:
 * single pill field with an animated border-colour when valid, plus
 * the reassurance line below. Parent owns the email state (it
 * persists across nav so a user bouncing back to this step doesn't
 * lose their input) and runs the actual `requestOtp` call on CTA.
 */
export function EmailEntry({
  active,
  copy,
  email,
  setEmail,
  error,
  inputRef,
}: EmailEntryProps): React.JSX.Element {
  // Lightweight client check — the real validity is whatever the
  // backend accepts, but this gates the "looks ok" border colour.
  const valid = /.+@.+\..+/.test(email);
  // Fallback focus-on-activation for swipe / keyboard nav, where
  // there's no click gesture to piggy-back on. Android ignores this
  // for the keyboard, but at least the caret is parked correctly.
  useEffect(() => {
    if (active) inputRef?.current?.focus();
  }, [active, inputRef]);
  return (
    <div className="flex-1 flex flex-col justify-center gap-4 px-6 py-6">
      <div>
        <h1
          className="text-[40px] font-bold leading-[1.02] text-gray-950 dark:text-white mb-3"
          style={{ letterSpacing: '-0.035em', textWrap: 'balance' }}
        >
          {copy.title}
        </h1>
        <p className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300">{copy.sub}</p>
      </div>

      <div
        className={
          'flex items-center rounded-[14px] bg-white dark:bg-gray-900 border px-4 h-14 transition-colors ' +
          (valid ? 'border-gray-950 dark:border-blue-400' : 'border-gray-200 dark:border-gray-800')
        }
      >
        <input
          ref={inputRef}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 border-0 outline-0 bg-transparent text-[17px] font-medium text-gray-950 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
          style={{ letterSpacing: 0.2 }}
        />
      </div>

      {error !== null ? (
        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 1.5L2 3v2.5c0 2.2 1.6 4.2 4 5 2.4-0.8 4-2.8 4-5V3L6 1.5z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          <span>Your email stays yours. We never sell contacts.</span>
        </div>
      )}
    </div>
  );
}

interface OtpEntryProps {
  active: boolean;
  copy: TailCopy;
  email: string;
  otp: string;
  setOtp: (v: string) => void;
  error: string | null;
  onResend: () => void;
  /**
   * Fired when the user completes the 6th digit. The completed OTP
   * is passed in directly rather than read from the parent's state
   * closure — the parent's `otp` state hasn't committed yet in the
   * input's event handler, so reading it there would lag by one
   * digit and the auto-verify would short-circuit on the
   * `otp.length === 6` guard.
   */
  onVerified: (otp: string) => void;
}

/**
 * Six-box OTP entry. Digits auto-advance on input and backspace
 * jumps back. Once the user hits six digits, we call `onVerified`
 * after a short confirmation delay — the parent handles the
 * `verifyOtp` network call there and advances the flow on success
 * or surfaces the error in `error` and leaves the user on this
 * screen so they can retry without losing their digits.
 */
export function OtpEntry({
  active,
  copy,
  email,
  otp,
  setOtp,
  error,
  onResend,
  onVerified,
}: OtpEntryProps): React.JSX.Element {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [clipboardCode, setClipboardCode] = useState<string | null>(null);
  const digits = useMemo(
    () =>
      otp
        .split('')
        .concat(Array(6 - otp.length).fill(''))
        .slice(0, 6),
    [otp],
  );

  // When the screen becomes active, park focus on the first empty
  // box so the user can type immediately without tapping — or the
  // first box if they're retrying after an error.
  useEffect(() => {
    if (!active) return;
    const idx = Math.min(otp.length, 5);
    inputs.current[idx]?.focus();
  }, [active, otp.length]);

  // Fills all six boxes from a single string (any 6-digit run wins).
  // Also kicks the verify when the run is a full code.
  const applyCode = (raw: string): void => {
    const match = raw.replace(/\D/g, '').match(/\d{6}/);
    if (match === null) return;
    const code = match[0];
    setOtp(code);
    inputs.current[5]?.focus();
    setClipboardCode(null);
    setTimeout(() => onVerified(code), 200);
  };

  // Peek at the clipboard whenever the user returns focus to the app —
  // common pattern is: receive email, switch to inbox, copy code,
  // switch back. If what's on the clipboard looks like a 6-digit
  // code, surface a "Paste 123456" pill above the boxes; tapping it
  // is the user gesture that actually reads+fills (avoids silently
  // snooping the clipboard without intent).
  useEffect(() => {
    if (!active) return;
    const peek = async (): Promise<void> => {
      const text = await readClipboard();
      if (text === null) return;
      const match = text.replace(/\D/g, '').match(/\d{6}/);
      if (match !== null) setClipboardCode(match[0]);
    };
    void peek();
    const onFocus = (): void => {
      void peek();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [active]);

  const setIdx = (i: number, v: string): void => {
    // User pasted a full code into one of the boxes — distribute it.
    if (v.length > 1) {
      applyCode(v);
      return;
    }
    if (!/^\d?$/.test(v)) return;
    const next = otp.split('');
    next[i] = v;
    const joined = next.join('').slice(0, 6);
    setOtp(joined);
    if (v && i < 5) inputs.current[i + 1]?.focus();
    if (joined.length === 6) {
      // Small delay so the final box reads as "filled" before we
      // kick off the verify call — feels less jumpy on device. The
      // completed value is captured in the closure so it survives
      // React's batched re-render.
      setTimeout(() => onVerified(joined), 350);
    }
  };
  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && digits[i] === '' && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text');
    const match = text.replace(/\D/g, '').match(/\d{6}/);
    if (match !== null) {
      e.preventDefault();
      applyCode(match[0]);
    }
  };

  return (
    <div className="flex-1 flex flex-col justify-center gap-4 px-6 py-6">
      <div>
        <h1
          className="text-[40px] font-bold leading-[1.02] text-gray-950 dark:text-white mb-3"
          style={{ letterSpacing: '-0.035em', textWrap: 'balance' }}
        >
          {copy.title}
        </h1>
        <p className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300">
          {copy.sub} <span className="text-gray-950 dark:text-white font-semibold">{email}</span>
        </p>
      </div>

      {clipboardCode !== null && otp.length === 0 && (
        <button
          type="button"
          onClick={() => applyCode(clipboardCode)}
          className="self-start inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-[13px] font-medium text-gray-700 dark:text-gray-200 shadow-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 2h6v2h4v18H5V4h4V2zm2 0v2h2V2h-2z"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
          <span>
            Paste <span className="font-mono">{clipboardCode}</span>
          </span>
        </button>
      )}

      <div className="grid grid-cols-6 gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              inputs.current[i] = el;
            }}
            value={d}
            onChange={(e) => setIdx(i, e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => onKey(i, e)}
            maxLength={6}
            inputMode="numeric"
            autoComplete="one-time-code"
            className={
              'aspect-square rounded-xl text-center min-w-0 outline-0 bg-white dark:bg-gray-900 ' +
              'text-[28px] font-semibold text-gray-950 dark:text-white border ' +
              (d !== ''
                ? 'border-gray-950 dark:border-blue-400'
                : 'border-gray-200 dark:border-gray-800')
            }
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          />
        ))}
      </div>

      {error !== null && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      <button
        type="button"
        onClick={onResend}
        className="h-10 self-start bg-transparent border-0 text-[15px] font-medium text-gray-600 dark:text-gray-300 cursor-pointer"
      >
        Resend code
      </button>
    </div>
  );
}

interface WelcomeInProps {
  active: boolean;
  copy: TailCopy;
}

/**
 * Final screen. Circle-grow + checkmark-draw + confetti burst on
 * entry, then the headline + sub fade up. The footer's "Open Loop"
 * CTA lives in the parent.
 */
export function WelcomeIn({ active, copy }: WelcomeInProps): React.JSX.Element {
  const [burst, setBurst] = useState(false);
  useEffect(() => {
    if (!active) {
      setBurst(false);
      return;
    }
    const t = setTimeout(() => setBurst(true), 120);
    return () => clearTimeout(t);
  }, [active]);

  // 24 confetti flecks spraying outward in a ring. Stable across
  // renders (useMemo on []) so the angles/delays/colours don't
  // re-shuffle when the Welcome-in remounts on theme change or CTA
  // press — that re-shuffle would show a frame of "jumpy" confetti.
  const confetti = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => ({
        angle: (i / 24) * Math.PI * 2 + Math.random() * 0.3,
        dist: 80 + Math.random() * 120,
        color: (['#3b82f6', '#22c55e', '#E5B041', '#030712'] as const)[i % 4]!,
        delay: Math.random() * 100,
        size: 6 + Math.random() * 4,
      })),
    [],
  );

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 relative">
      <div
        className="absolute pointer-events-none"
        style={{ top: '38%', left: '50%', width: 0, height: 0 }}
      >
        {confetti.map((c, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: c.size,
              height: c.size * 0.4,
              borderRadius: 1,
              background: c.color,
              opacity: 0,
              animation: burst
                ? `loop-onboard-confetti-${i} 900ms cubic-bezier(0.2,0.7,0.3,1) ${c.delay}ms forwards`
                : 'none',
            }}
          />
        ))}
      </div>

      <div
        className="w-[72px] h-[72px] rounded-full bg-gray-950 dark:bg-white flex items-center justify-center mb-6"
        style={{
          transform: burst ? 'scale(1)' : 'scale(0)',
          transition: 'transform 500ms cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path
            d="M8 16l6 6L24 10"
            stroke="currentColor"
            className="text-white dark:text-gray-950"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 30,
              strokeDashoffset: burst ? 0 : 30,
              transition: 'stroke-dashoffset 400ms ease 250ms',
            }}
          />
        </svg>
      </div>

      <h1
        className="text-[32px] font-extrabold tracking-[-0.03em] m-0 text-center text-gray-950 dark:text-white"
        style={{
          opacity: burst ? 1 : 0,
          transform: burst ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 400ms ease 200ms, transform 400ms ease 200ms',
        }}
      >
        {copy.title}
      </h1>
      <p
        className="text-[16px] text-gray-600 dark:text-gray-300 text-center mx-0 mt-3 max-w-[280px] leading-[1.4]"
        style={{
          opacity: burst ? 1 : 0,
          transform: burst ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 400ms ease 300ms, transform 400ms ease 300ms',
        }}
      >
        {copy.sub}
      </p>

      <style>
        {confetti
          .map(
            (c, i) => `
          @keyframes loop-onboard-confetti-${i} {
            0% { opacity: 1; transform: translate(0,0) rotate(0); }
            100% {
              opacity: 0;
              transform: translate(${(Math.cos(c.angle) * c.dist).toFixed(1)}px, ${(Math.sin(c.angle) * c.dist + 40).toFixed(1)}px) rotate(${(c.angle * 3).toFixed(3)}rad);
            }
          }`,
          )
          .join('\n')}
      </style>
    </div>
  );
}

/**
 * Shared auth-state API the container uses to drive the two network
 * screens. Wraps `requestOtp` / `verifyOtp` with in-flight guards +
 * friendly error strings; callers hydrate the auth store on a
 * successful verify.
 */
export function useOnboardingAuth(): {
  sendingOtp: boolean;
  verifyingOtp: boolean;
  otpError: string | null;
  emailError: string | null;
  sendOtp: (email: string) => Promise<boolean>;
  verify: (email: string, otp: string) => Promise<boolean>;
  clearErrors: () => void;
} {
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);

  const sendOtp = async (email: string): Promise<boolean> => {
    setEmailError(null);
    setSendingOtp(true);
    try {
      await requestOtp(email);
      return true;
    } catch (err) {
      setEmailError(friendlyError(err, 'Failed to send verification code.'));
      return false;
    } finally {
      setSendingOtp(false);
    }
  };

  const verify = async (email: string, otp: string): Promise<boolean> => {
    setOtpError(null);
    setVerifyingOtp(true);
    try {
      const { accessToken, refreshToken } = await verifyOtp(email, otp);
      useAuthStore.getState().setSession(email, accessToken, refreshToken ?? null);
      return true;
    } catch (err) {
      setOtpError(friendlyError(err, 'Invalid code. Please try again.'));
      return false;
    } finally {
      setVerifyingOtp(false);
    }
  };

  const clearErrors = (): void => {
    setEmailError(null);
    setOtpError(null);
  };

  return { sendingOtp, verifyingOtp, otpError, emailError, sendOtp, verify, clearErrors };
}
