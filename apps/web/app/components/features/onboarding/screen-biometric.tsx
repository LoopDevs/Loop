import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticateWithBiometrics } from '~/native/biometrics';
import { setAppLockEnabled, markAppLockJustVerified } from '~/native/app-lock';
import { useReducedMotion } from './atoms';

interface BiometricSetupProps {
  active: boolean;
  copy: { title: string; sub: string };
  /** null = still checking, true = offer the prompt, false = unavailable. */
  available: boolean | null;
  /** Called once the user has successfully enabled biometrics. */
  onEnabled: () => void;
  /**
   * Parent can fire this to start the biometric prompt — the footer
   * CTA lives in `Onboarding`, not on this screen, so the parent
   * needs an imperative handle on "start the scan now".
   */
  triggerRef: React.MutableRefObject<(() => void) | null>;
}

/**
 * Biometric-enable step. Matches the Claude Design mockup 1:1 —
 * dashed ring + Face ID glyph, ring rotates during the scan, green
 * checkmark on success — but wires the tap through to the real
 * Capacitor `BiometricAuth.authenticate` and then toggles our
 * app-lock preference on success. If biometrics aren't available on
 * the device, the screen self-skips via `onEnabled` so the user
 * never sees a non-functional prompt.
 *
 * The glyph and copy are Face-ID-shaped regardless of what the
 * device actually has (fingerprint on most Android, Face ID on
 * iPhone). That's the design's call — one identity for the step
 * rather than a per-device split. `authenticateWithBiometrics`
 * still calls into whatever hardware is available, so the prompt
 * the OS shows the user is correct; only the onboarding framing
 * is stylised.
 */
export function BiometricSetup({
  active,
  copy,
  available,
  onEnabled,
  triggerRef,
}: BiometricSetupProps): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const reduced = useReducedMotion();
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  // FE-55: biometric-failure feedback. A cancelled / failed prompt used
  // to reset silently — the ring went back to idle with no explanation,
  // and because the footer CTA only ever re-fires the prompt, a user
  // whose biometrics keep failing had no visible signal AND no way off
  // the step. Track the failure so the screen can (a) tell the user what
  // happened and (b) surface a "Skip for now" escape.
  const [failed, setFailed] = useState(false);

  // Reset visual state whenever the screen goes inactive — otherwise
  // navigating Back and returning leaves the ring stuck in its last
  // state (e.g. "scanning…" after a mid-prompt cancel).
  useEffect(() => {
    if (!active) {
      setScanning(false);
      setDone(false);
      setFailed(false);
    }
  }, [active]);

  // If the device can't do biometrics at all, slip past this step
  // after a short beat so the transition is visible but not dwell-y.
  useEffect(() => {
    if (!active || available !== false) return;
    const t = setTimeout(() => onEnabled(), 400);
    return () => clearTimeout(t);
  }, [active, available, onEnabled]);

  // Expose the "start the scan" action to the parent for the footer
  // CTA. Registered on every render so the captured closures
  // (scanning/done) stay fresh — a ref-set once at mount would read
  // stale state from the first render.
  useEffect(() => {
    if (!active) {
      triggerRef.current = null;
      return;
    }
    triggerRef.current = () => {
      if (done || scanning || available !== true) return;
      void (async () => {
        setScanning(true);
        setFailed(false);
        const ok = await authenticateWithBiometrics(t('biometric.enableReason'));
        if (!ok) {
          // FE-55: surface the failure instead of resetting silently.
          setScanning(false);
          setFailed(true);
          return;
        }
        await setAppLockEnabled(true);
        // Tell the app-lock guard to skip its first prompt this
        // session — the user literally just authenticated a
        // second ago, re-prompting on the home route transition
        // feels like a bug.
        markAppLockJustVerified();
        setScanning(false);
        setDone(true);
        // Short hold so the user sees the green check confirm
        // before we slide to the welcome-in screen.
        setTimeout(() => onEnabled(), 600);
      })();
    };
    return () => {
      triggerRef.current = null;
    };
  }, [active, available, done, scanning, onEnabled, triggerRef, t]);

  // "Face ID" is an Apple product name \u2014 never translated, same convention
  // as auth.tsx's biometric-label handling (docs/i18n.md #7). The design
  // deliberately shows Face-ID-shaped copy regardless of what the device
  // actually has (see the file header comment), so this is a fixed literal
  // rather than a device-derived value like auth.tsx's `biometryType`.
  const biometricLabel = 'Face ID';
  const statusTitle = done
    ? t('biometric.status.enabled', { type: biometricLabel })
    : scanning
      ? t('biometric.status.scanning')
      : failed
        ? t('biometric.status.failed')
        : available === false
          ? t('biometric.status.unavailable')
          : t('biometric.status.use', { type: biometricLabel });
  const statusSub = done
    ? t('biometric.sub.enabled', { type: biometricLabel })
    : failed
      ? t('biometric.sub.failed', { type: biometricLabel })
      : available === false
        ? t('biometric.sub.unavailable')
        : t('biometric.sub.default');

  return (
    <div className="flex-1 flex flex-col justify-center gap-6 px-6 py-6">
      <div>
        <h1
          className="text-[32px] font-bold leading-[1.1] text-gray-950 dark:text-white mb-3"
          style={{ letterSpacing: '-0.02em', textWrap: 'balance' }}
        >
          {copy.title}
        </h1>
        <p
          className="text-[16px] leading-[1.45] text-gray-600 dark:text-gray-300"
          style={{ textWrap: 'pretty' }}
        >
          {copy.sub}
        </p>
      </div>

      <div className="flex flex-col items-center gap-6">
        {/* Ring + inner circle, lifted directly from the design:
            dashed 2px ring (148×148), solid 116×116 inner. Ring
            rotates while scanning, flips green + solid when done. */}
        <div
          className="relative flex items-center justify-center"
          style={{ width: 148, height: 148 }}
        >
          <div
            className={
              'absolute inset-0 rounded-full transition-[opacity,border-color] duration-300 ' +
              // FE-53: suppress the continuous scan spin under reduced motion.
              (scanning && !reduced
                ? 'animate-[loop-onboard-biometric-spin_2s_linear_infinite] '
                : '') +
              (done ? 'opacity-100 ' : scanning ? 'opacity-100 ' : 'opacity-25 ')
            }
            style={{
              borderStyle: 'dashed',
              borderWidth: 2,
              borderColor: done ? '#22c55e' : 'currentColor',
            }}
          />
          <div
            className="flex items-center justify-center rounded-full transition-[background,transform] duration-300 bg-gray-100 dark:bg-gray-800"
            style={{
              width: 116,
              height: 116,
              background: done ? '#22c55e' : undefined,
              transform: done ? 'scale(1.04)' : 'scale(1)',
            }}
          >
            {done ? (
              <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
                <path
                  d="M14 26l8 8 16-16"
                  stroke="#fff"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              // Face ID glyph — square viewport + face. Identical to
              // the design's SVG so the onboarding visual matches
              // the mockup exactly.
              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <path
                  d="M10 22V14a4 4 0 0 1 4-4h8M42 10h8a4 4 0 0 1 4 4v8M54 42v8a4 4 0 0 1-4 4h-8M22 54h-8a4 4 0 0 1-4-4v-8"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <circle cx="24" cy="26" r="1.8" fill="currentColor" />
                <circle cx="40" cy="26" r="1.8" fill="currentColor" />
                <path
                  d="M32 24v10h-3"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path
                  d="M24 40c2 2 5 3 8 3s6-1 8-3"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            )}
          </div>
        </div>

        <div className="text-center">
          <div
            className={
              'text-[15px] font-semibold ' +
              (failed ? 'text-red-600 dark:text-red-400' : 'text-gray-950 dark:text-white')
            }
          >
            {statusTitle}
          </div>
          {/* FE-55: announce the failure to assistive tech and, on
              failure, give a plain escape so a user who can't pass
              biometrics isn't trapped on the step (the footer CTA only
              ever re-fires the prompt). */}
          <div
            className="text-[13px] text-gray-500 dark:text-gray-400 mt-1 max-w-[260px] leading-[1.4] mx-auto"
            {...(failed ? { role: 'alert' } : {})}
          >
            {statusSub}
          </div>
          {failed ? (
            <button
              type="button"
              onClick={onEnabled}
              className="mt-3 text-[13px] font-semibold text-blue-600 dark:text-blue-400 underline underline-offset-2"
            >
              {t('biometric.skip')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-xl bg-gray-50 dark:bg-gray-900 text-xs text-gray-600 dark:text-gray-300 leading-[1.4]">
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          aria-hidden="true"
          className="flex-shrink-0"
        >
          <rect x="4" y="8" width="10" height="7" rx="1.2" stroke="#22c55e" strokeWidth="1.4" />
          <path d="M6 8V6a3 3 0 0 1 6 0v2" stroke="#22c55e" strokeWidth="1.4" />
        </svg>
        <span>{t('biometric.privacyNote')}</span>
      </div>

      <style>{`@keyframes loop-onboard-biometric-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
