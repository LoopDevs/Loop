// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
