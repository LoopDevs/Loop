import { Capacitor } from '@capacitor/core';
import { checkBiometrics, authenticateWithBiometrics } from './biometrics';

const APP_LOCK_KEY = 'loop_app_lock_enabled';

// FE-02: re-lock on foreground only after the app has been backgrounded
// for at least this long. A short grace window keeps brief context
// switches (glancing at a notification, copying an OTP from Messages,
// a 5-second app flip) from re-prompting — which is the "hostile for no
// benefit" case the original cold-start-only design called out — while
// still gating the "phone left on a table / handed to someone / picked
// up minutes later" case the audit (FE-02) flagged as the real gap in
// cold-start-only locking. 60s mirrors the common banking-app default.
const FOREGROUND_RELOCK_AFTER_MS = 60_000;

/** Checks if app lock is enabled in user preferences. */
export async function isAppLockEnabled(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: APP_LOCK_KEY });
    return value === 'true';
  } catch {
    return false;
  }
}

/** Enables or disables app lock. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: APP_LOCK_KEY, value: String(enabled) });
}

// In-memory "skip the next lock check" flag. Set by onboarding right
// after the user authenticates with biometrics to enable app-lock,
// so the immediately-mounting NativeShell doesn't re-prompt in the
// same session (the user just authenticated — re-prompting seconds
// later feels broken). Cleared by `runLockCheck` on the first call,
// and naturally dies on process restart so the next real cold boot
// still gates correctly.
let skipNextLockCheck = false;

/**
 * Called from the onboarding biometric step after a successful
 * enable. Suppresses the very next lock-guard prompt so the user
 * isn't asked to authenticate twice in a single session.
 */
export function markAppLockJustVerified(): void {
  skipNextLockCheck = true;
}

/**
 * Prompts for biometrics on cold start when app-lock is enabled, and
 * re-prompts on foreground after a grace window (FE-02). Returns a
 * cleanup function.
 *
 * Design history: the original design was cold-start-only and
 * deliberately did NOT re-prompt on resume (rationale: a Loop gift card
 * can only be bought by paying XLM from the user's own wallet, so a
 * phone thief with an unlocked handset still can't make a fraudulent
 * purchase, and re-auth on every brief context switch feels hostile).
 * M-5 re-examined resume-relock and deferred it again.
 *
 * FE-02 (2026-07 audit) reversed that: cold-start-only was flagged as a
 * gap because a phone left unlocked on a desk, or handed to someone, or
 * picked up minutes later, exposes every already-visible balance /
 * gift-card code with no re-gate. The reconciliation with the original
 * "don't be hostile" concern is the grace window
 * (`FOREGROUND_RELOCK_AFTER_MS`): brief switches don't re-prompt; a real
 * absence does. Still opt-in (off by default, same `APP_LOCK_KEY`
 * preference) and still not a purchase gate — it gates UI visibility.
 * NOTE for QA sign-off: this changes the documented M-5 decision; if the
 * product prefers cold-start-only, set the grace window to Infinity (or
 * drop the resume listener) — the cold-start path is unchanged.
 */
export function registerAppLockGuard(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let overlay: HTMLDivElement | null = null;
  // Cancellation flag — the async check below kicks off at registration
  // time. If cleanup runs while it is still in-flight, its eventual
  // showLockScreen() would leak an overlay onto a page the caller has
  // already torn down. Flag every branch against `cancelled` before
  // mutating DOM.
  let cancelled = false;

  const showLockScreen = (message: string, unlockable: boolean): void => {
    if (cancelled) return;
    if (overlay === null) {
      // Match the splash screen's look (background + logo) so the overlay
      // feels like a natural extension of the app's boot state rather than
      // a jarring security prompt. Theme follows the html.dark class set by
      // the inline theme script in root.tsx so it paints correctly on the
      // very first paint.
      const isDark = document.documentElement.classList.contains('dark');
      const bg = isDark ? 'rgb(3, 7, 18)' : 'rgb(249, 250, 251)';
      const fg = isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(17, 24, 39, 0.55)';
      const logo = isDark ? '/loop-logo-white.svg' : '/loop-logo.svg';
      overlay = document.createElement('div');
      overlay.id = 'app-lock-overlay';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:99998',
        `background:${bg}`,
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'flex-direction:column',
        'gap:1.25rem',
        'opacity:1',
        'transition:opacity 200ms ease-out',
      ].join(';');
      overlay.innerHTML = `
        <img src="${logo}" alt="Loop" style="height:2.5rem" />
        <div data-lock-message style="color:${fg};font-size:0.875rem;letter-spacing:0.01em;text-align:center;max-width:18rem;"></div>
      `;
      overlay.addEventListener('click', () => {
        if (overlay?.dataset.unlockable !== 'true') return;
        void attemptUnlock();
      });
      document.body.appendChild(overlay);
    }
    overlay.dataset.unlockable = unlockable ? 'true' : 'false';
    overlay.style.cursor = unlockable ? 'pointer' : 'default';
    const messageNode = overlay.querySelector<HTMLElement>('[data-lock-message]');
    if (messageNode !== null) {
      messageNode.textContent = message;
    }
  };

  const hideLockScreen = (): void => {
    if (!overlay) return;
    // Fade out so the content reveal feels intentional, not a flicker.
    // Detach a local reference because the class-level `overlay` gets
    // nulled immediately — otherwise a rapid re-show could race against
    // the scheduled removal and drop the new overlay instead of the old.
    const el = overlay;
    el.style.opacity = '0';
    overlay = null;
    window.setTimeout(() => el.remove(), 200);
  };

  const attemptUnlock = async (): Promise<void> => {
    const ok = await authenticateWithBiometrics('Unlock Loop');
    if (!cancelled && ok) hideLockScreen();
  };

  const runLockCheck = async (): Promise<void> => {
    const enabled = await isAppLockEnabled();
    if (cancelled || !enabled) return;
    // Consume the "just-verified" flag — set by onboarding so the
    // biometric-enable step doesn't immediately trigger a second
    // prompt when NativeShell mounts post-flow. Clearing it here
    // means only the very next check is suppressed; any subsequent
    // cold boot still gates normally.
    if (skipNextLockCheck) {
      skipNextLockCheck = false;
      return;
    }
    const { available, deviceIsSecure } = await checkBiometrics();
    if (cancelled) return;
    if (!available && !deviceIsSecure) {
      showLockScreen('Turn on a device passcode or biometrics to unlock Loop.', false);
      return;
    }
    showLockScreen(available ? 'Unlock to continue' : 'Use your device passcode to continue', true);
    void attemptUnlock();
  };

  // If the app boots while the OS is still transitioning — e.g. the user
  // launched from a notification so the device hasn't finished unlocking —
  // firing the biometric prompt immediately makes the overlay appear over
  // the system lock screen, which is confusing and occasionally results
  // in the prompt itself getting dismissed by the keyguard. Wait until
  // the document is actually visible (Android fires `visibilitychange`
  // once the app is really on top) before prompting.
  const startWhenVisible = (): void => {
    if (cancelled) return;
    if (document.visibilityState === 'visible') {
      void runLockCheck();
      return;
    }
    const handler = (): void => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', handler);
      if (!cancelled) void runLockCheck();
    };
    document.addEventListener('visibilitychange', handler);
  };

  startWhenVisible();

  // FE-02: foreground re-lock. Capacitor dispatches `pause` when the OS
  // backgrounds the app and `resume` when it returns to the foreground
  // (the same events `task-switcher-overlay.ts` uses). Record when we
  // went to the background, and on return re-run the lock check if the
  // absence exceeded the grace window.
  let backgroundedAt: number | null = null;

  const onPause = (): void => {
    backgroundedAt = Date.now();
  };

  const onResume = (): void => {
    if (cancelled) return;
    // A lock overlay is already up (cold-start lock never unlocked, or a
    // prior resume-lock) — don't stack a second biometric prompt.
    if (overlay !== null) return;
    const since = backgroundedAt;
    backgroundedAt = null;
    if (since === null) return;
    if (Date.now() - since < FOREGROUND_RELOCK_AFTER_MS) return;
    void runLockCheck();
  };

  document.addEventListener('pause', onPause);
  document.addEventListener('resume', onResume);

  return () => {
    cancelled = true;
    document.removeEventListener('pause', onPause);
    document.removeEventListener('resume', onResume);
    hideLockScreen();
  };
}
