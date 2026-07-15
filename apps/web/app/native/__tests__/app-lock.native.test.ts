// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  enabled: true,
  biometric: {
    available: false,
    biometryType: 'none' as const,
    deviceIsSecure: true,
  },
  authOk: true,
  checkBiometricsMock: vi.fn(async () => state.biometric),
  authenticateWithBiometricsMock: vi.fn(async (_reason: string) => state.authOk),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
  },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: state.enabled ? 'true' : 'false' })),
    set: vi.fn(async () => undefined),
  },
}));

vi.mock('../biometrics', () => ({
  checkBiometrics: state.checkBiometricsMock,
  authenticateWithBiometrics: state.authenticateWithBiometricsMock,
}));

import { registerAppLockGuard } from '../app-lock';

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe('registerAppLockGuard (native)', () => {
  beforeEach(() => {
    state.enabled = true;
    state.biometric = {
      available: false,
      biometryType: 'none',
      deviceIsSecure: true,
    };
    state.authOk = true;
    state.checkBiometricsMock.mockClear();
    state.authenticateWithBiometricsMock.mockClear();
    document.body.innerHTML = '';
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('falls back to device credentials when biometrics are unavailable but the device is secure', async () => {
    const cleanup = registerAppLockGuard();
    await flushEffects();

    expect(state.checkBiometricsMock).toHaveBeenCalledTimes(1);
    expect(state.authenticateWithBiometricsMock).toHaveBeenCalledWith('Unlock Loop');
    const overlay = document.getElementById('app-lock-overlay');
    expect(overlay?.dataset.unlockable).toBe('true');

    cleanup();
  });

  it('fails closed when neither biometrics nor a secure device credential is available', async () => {
    state.biometric = {
      available: false,
      biometryType: 'none',
      deviceIsSecure: false,
    };

    const cleanup = registerAppLockGuard();
    await flushEffects();

    expect(state.authenticateWithBiometricsMock).not.toHaveBeenCalled();
    const overlay = document.getElementById('app-lock-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.dataset.unlockable).toBe('false');
    expect(overlay?.textContent).toContain(
      'Turn on a device passcode or biometrics to unlock Loop.',
    );

    cleanup();
  });

  // FE-02: foreground re-lock after the grace window.
  describe('foreground re-lock', () => {
    let nowSpy: ReturnType<typeof vi.spyOn>;
    let clock: number;

    beforeEach(() => {
      clock = 1_000_000;
      nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    async function coldStartThenUnlock(): Promise<() => void> {
      // available=false + deviceSecure=true + authOk=true → cold-start
      // prompt succeeds and the overlay is dismissed, leaving us unlocked.
      const cleanup = registerAppLockGuard();
      await flushEffects();
      expect(state.checkBiometricsMock).toHaveBeenCalledTimes(1);
      // Let the 200ms fade-out remove the old overlay element.
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      return cleanup;
    }

    it('re-locks on resume after more than the grace window in the background', async () => {
      const cleanup = await coldStartThenUnlock();

      clock = 1_000_000; // background timestamp
      document.dispatchEvent(new Event('pause'));
      clock = 1_000_000 + 61_000; // 61s later — past the 60s grace window
      document.dispatchEvent(new Event('resume'));
      await flushEffects();

      // A second lock check fired on resume.
      expect(state.checkBiometricsMock).toHaveBeenCalledTimes(2);
      expect(document.getElementById('app-lock-overlay')).not.toBeNull();

      cleanup();
    });

    it('does NOT re-lock on a brief background switch (within the grace window)', async () => {
      const cleanup = await coldStartThenUnlock();

      clock = 1_000_000;
      document.dispatchEvent(new Event('pause'));
      clock = 1_000_000 + 5_000; // only 5s — a glance at a notification
      document.dispatchEvent(new Event('resume'));
      await flushEffects();

      // No second lock check, no overlay.
      expect(state.checkBiometricsMock).toHaveBeenCalledTimes(1);
      expect(document.getElementById('app-lock-overlay')).toBeNull();

      cleanup();
    });

    it('stops re-locking after cleanup (listeners removed)', async () => {
      const cleanup = await coldStartThenUnlock();
      cleanup();

      clock = 1_000_000;
      document.dispatchEvent(new Event('pause'));
      clock = 1_000_000 + 120_000;
      document.dispatchEvent(new Event('resume'));
      await flushEffects();

      expect(state.checkBiometricsMock).toHaveBeenCalledTimes(1);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });
  });
});
