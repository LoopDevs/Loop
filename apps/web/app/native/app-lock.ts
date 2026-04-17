import { Capacitor } from '@capacitor/core';
import { checkBiometrics, authenticateWithBiometrics } from './biometrics';

const APP_LOCK_KEY = 'loop_app_lock_enabled';

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

/**
 * Registers a listener that prompts for biometrics when app resumes from
 * background AND on initial registration (cold start). Returns a cleanup
 * function.
 *
 * Covering cold start matters: the resume event only fires when the app
 * transitions from background to foreground. A stolen-phone scenario
 * where the thief kills and relaunches the app skips that transition
 * entirely, so app lock without a cold-start check leaves a gap right
 * where it's needed most.
 */
export function registerAppLockGuard(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let overlay: HTMLDivElement | null = null;
  // Cancellation flag — the async check below kicks off at registration
  // time and again on every resume. If cleanup runs while one is still
  // in-flight, its eventual showLockScreen() would leak an overlay onto
  // a page the caller has already torn down. Flag every branch against
  // `cancelled` before mutating DOM.
  let cancelled = false;
  // The native biometric dialog is itself a system-level window —
  // opening/closing it causes Android to emit pause/resume around the
  // prompt. Without this guard, every successful unlock immediately
  // triggered a resume → runLockCheck → prompt again, looping forever.
  // If a resume fires within this window of an unlock, treat it as part
  // of the dialog lifecycle and skip. Three seconds comfortably covers
  // the auth dialog's tear-down; a genuine background → foreground
  // trip in that window is not a threat anyone cares about.
  const UNLOCK_GRACE_MS = 3000;
  let lastUnlockedAt = 0;

  const showLockScreen = (): void => {
    if (cancelled) return;
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'app-lock-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99998;background:rgb(3,7,18);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1rem;';
    overlay.innerHTML =
      '<div style="font-size:3rem">&#128274;</div><div style="color:white;font-size:1rem">Tap to unlock</div>';
    overlay.addEventListener('click', () => {
      void attemptUnlock();
    });
    document.body.appendChild(overlay);
  };

  const hideLockScreen = (): void => {
    overlay?.remove();
    overlay = null;
  };

  const attemptUnlock = async (): Promise<void> => {
    const ok = await authenticateWithBiometrics('Unlock Loop');
    if (!cancelled && ok) {
      lastUnlockedAt = Date.now();
      hideLockScreen();
    }
  };

  const runLockCheck = async (): Promise<void> => {
    if (Date.now() - lastUnlockedAt < UNLOCK_GRACE_MS) return;
    const enabled = await isAppLockEnabled();
    if (cancelled || !enabled) return;
    const { available } = await checkBiometrics();
    if (cancelled || !available) return;
    showLockScreen();
    void attemptUnlock();
  };

  const onResume = (): void => {
    void runLockCheck();
  };

  // Cold-start check — runs once as soon as the guard is registered.
  void runLockCheck();

  document.addEventListener('resume', onResume);
  return () => {
    cancelled = true;
    document.removeEventListener('resume', onResume);
    hideLockScreen();
  };
}
