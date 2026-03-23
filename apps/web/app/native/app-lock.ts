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
 * Registers a listener that prompts for biometrics when app resumes.
 * Returns a cleanup function.
 */
export function registerAppLockGuard(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let overlay: HTMLDivElement | null = null;

  const showLockScreen = (): void => {
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
    if (ok) hideLockScreen();
  };

  const onResume = (): void => {
    void (async () => {
      const enabled = await isAppLockEnabled();
      const { available } = await checkBiometrics();
      if (enabled && available) {
        showLockScreen();
        void attemptUnlock();
      }
    })();
  };

  document.addEventListener('resume', onResume);
  return () => {
    document.removeEventListener('resume', onResume);
    hideLockScreen();
  };
}
