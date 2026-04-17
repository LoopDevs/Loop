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
 * Prompts for biometrics once on cold start when app-lock is enabled.
 * Returns a cleanup function.
 *
 * Design choice: we intentionally do NOT re-prompt on resume. A Loop gift
 * card can only be bought by paying XLM from the user's own wallet, so a
 * phone thief in possession of an unlocked handset still can't make a
 * fraudulent purchase. Re-authenticating on every brief context switch
 * (pulling down notifications, reading an SMS, switching apps for five
 * seconds) makes the app feel hostile for no real security benefit. The
 * cold-start prompt catches the "someone found/stole a locked phone and
 * managed to get it unlocked" case; anything more is theatre.
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
    if (!cancelled && ok) hideLockScreen();
  };

  const runLockCheck = async (): Promise<void> => {
    const enabled = await isAppLockEnabled();
    if (cancelled || !enabled) return;
    const { available } = await checkBiometrics();
    if (cancelled || !available) return;
    showLockScreen();
    void attemptUnlock();
  };

  // Cold-start check only — no resume listener (see function docstring).
  void runLockCheck();

  return () => {
    cancelled = true;
    hideLockScreen();
  };
}
