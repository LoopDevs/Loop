import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Capacitor core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

// Mock sessionStorage for secure-storage tests
const mockSessionStorage = {
  store: new Map<string, string>(),
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  },
  removeItem(key: string): void {
    this.store.delete(key);
  },
};
Object.defineProperty(globalThis, 'sessionStorage', {
  value: mockSessionStorage,
  writable: true,
});

// Mock window for network module (Node env has no window)
const windowListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockWindow = {
  addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!windowListeners[event]) windowListeners[event] = [];
    windowListeners[event].push(handler);
  }),
  removeEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (windowListeners[event]) {
      windowListeners[event] = windowListeners[event].filter((h) => h !== handler);
    }
  }),
};
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', { value: mockWindow, writable: true });
}

// Mock document for screenshot-guard and app-lock tests
const documentListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockDocument = {
  addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!documentListeners[event]) documentListeners[event] = [];
    documentListeners[event].push(handler);
  }),
  removeEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (documentListeners[event]) {
      documentListeners[event] = documentListeners[event].filter((h) => h !== handler);
    }
  }),
  createElement: vi.fn(() => ({
    id: '',
    style: { cssText: '' },
    innerHTML: '',
    addEventListener: vi.fn(),
    remove: vi.fn(),
  })),
  body: {
    appendChild: vi.fn(),
    children: { length: 0 },
  },
};
if (typeof globalThis.document === 'undefined') {
  Object.defineProperty(globalThis, 'document', { value: mockDocument, writable: true });
}

// Mock navigator for network and share tests
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    writable: true,
    configurable: true,
  });
}

// Import modules under test
import { getPlatform, isNativePlatform } from '../platform';
import { copyToClipboard } from '../clipboard';
import { triggerHaptic, triggerHapticNotification } from '../haptics';
import { storeRefreshToken, getRefreshToken, clearRefreshToken } from '../secure-storage';
import { setStatusBarStyle, setStatusBarOverlay } from '../status-bar';
import { registerBackButton } from '../back-button';
import { watchNetwork } from '../network';
import { enableScreenshotGuard } from '../screenshot-guard';
import { nativeShare } from '../share';
import { checkBiometrics, authenticateWithBiometrics } from '../biometrics';
import { isAppLockEnabled, setAppLockEnabled, registerAppLockGuard } from '../app-lock';
import { openWebView } from '../webview';

// ────────────────────────────────────────────────────────────
// 1. Platform
// ────────────────────────────────────────────────────────────
describe('platform', () => {
  it('returns web platform by default', () => {
    expect(getPlatform()).toBe('web');
  });

  it('isNativePlatform returns false on web', () => {
    expect(isNativePlatform()).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 2. Clipboard
// ────────────────────────────────────────────────────────────
describe('clipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('copies to clipboard on web using navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const result = await copyToClipboard('test text');
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('test text');
  });

  it('returns false if clipboard write fails', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const result = await copyToClipboard('test');
    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 3. Haptics
// ────────────────────────────────────────────────────────────
describe('haptics', () => {
  it('triggerHaptic is a no-op on web', async () => {
    await expect(triggerHaptic()).resolves.toBeUndefined();
  });

  it('triggerHapticNotification is a no-op on web', async () => {
    await expect(triggerHapticNotification('success')).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 4. Secure Storage
// ────────────────────────────────────────────────────────────
describe('secure-storage', () => {
  beforeEach(() => {
    mockSessionStorage.store.clear();
  });

  it('storeRefreshToken stores in sessionStorage on web', async () => {
    await storeRefreshToken('my-refresh-token');
    expect(mockSessionStorage.store.get('loop_refresh_token')).toBe('my-refresh-token');
  });

  it('getRefreshToken reads from sessionStorage on web', async () => {
    mockSessionStorage.store.set('loop_refresh_token', 'stored-token');
    const token = await getRefreshToken();
    expect(token).toBe('stored-token');
  });

  it('getRefreshToken returns null when sessionStorage is empty', async () => {
    const token = await getRefreshToken();
    expect(token).toBeNull();
  });

  it('clearRefreshToken removes from sessionStorage on web', async () => {
    mockSessionStorage.store.set('loop_refresh_token', 'to-be-cleared');
    await clearRefreshToken();
    expect(mockSessionStorage.store.has('loop_refresh_token')).toBe(false);
  });

  it('storeRefreshToken overwrites existing token', async () => {
    await storeRefreshToken('token-v1');
    await storeRefreshToken('token-v2');
    expect(mockSessionStorage.store.get('loop_refresh_token')).toBe('token-v2');
  });
});

// ────────────────────────────────────────────────────────────
// 5. Status Bar
// ────────────────────────────────────────────────────────────
describe('status-bar', () => {
  it('setStatusBarStyle is a no-op on web', async () => {
    await expect(setStatusBarStyle('dark')).resolves.toBeUndefined();
  });

  it('setStatusBarStyle resolves for light style too', async () => {
    await expect(setStatusBarStyle('light')).resolves.toBeUndefined();
  });

  it('setStatusBarOverlay is a no-op on web', async () => {
    await expect(setStatusBarOverlay()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 6. Back Button
// ────────────────────────────────────────────────────────────
describe('back-button', () => {
  it('registerBackButton is a no-op on web', () => {
    expect(() => registerBackButton()).not.toThrow();
  });

  it('registerBackButton returns undefined', () => {
    const result = registerBackButton();
    expect(result).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 7. Network
// ────────────────────────────────────────────────────────────
describe('network', () => {
  beforeEach(() => {
    // Clear tracked listeners and reset mock call history
    for (const key of Object.keys(windowListeners)) {
      delete windowListeners[key];
    }
    mockWindow.addEventListener.mockClear();
    mockWindow.removeEventListener.mockClear();
  });

  it('watchNetwork calls callback with navigator.onLine value on web', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    watchNetwork(callback);

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('watchNetwork calls callback with false when offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const callback = vi.fn();

    watchNetwork(callback);

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('watchNetwork registers online and offline event listeners', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    watchNetwork(callback);

    expect(mockWindow.addEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(mockWindow.addEventListener).toHaveBeenCalledWith('offline', expect.any(Function));
  });

  it('watchNetwork returns an unsubscribe function', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    const unsubscribe = watchNetwork(callback);
    expect(typeof unsubscribe).toBe('function');
  });

  it('unsubscribe removes online and offline event listeners', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    const unsubscribe = watchNetwork(callback);
    unsubscribe();

    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(mockWindow.removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function));
  });

  it('online event triggers callback with true', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    watchNetwork(callback);
    callback.mockClear();

    // Find the 'online' handler that was registered
    const onlineCall = mockWindow.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'online',
    );
    const onlineHandler = onlineCall![1] as () => void;
    onlineHandler();

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('offline event triggers callback with false', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const callback = vi.fn();

    watchNetwork(callback);
    callback.mockClear();

    // Find the 'offline' handler that was registered
    const offlineCall = mockWindow.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'offline',
    );
    const offlineHandler = offlineCall![1] as () => void;
    offlineHandler();

    expect(callback).toHaveBeenCalledWith(false);
  });
});

// ────────────────────────────────────────────────────────────
// 8. Screenshot Guard
// ────────────────────────────────────────────────────────────
describe('screenshot-guard', () => {
  it('enableScreenshotGuard returns a cleanup function on web', () => {
    const cleanup = enableScreenshotGuard();
    expect(typeof cleanup).toBe('function');
  });

  it('cleanup function is a no-op on web (does not throw)', () => {
    const cleanup = enableScreenshotGuard();
    expect(() => cleanup()).not.toThrow();
  });

  it('does not register pause/resume event listeners on web', () => {
    mockDocument.addEventListener.mockClear();
    enableScreenshotGuard();
    const pauseCall = mockDocument.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'pause',
    );
    const resumeCall = mockDocument.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'resume',
    );
    expect(pauseCall).toBeUndefined();
    expect(resumeCall).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 9. Share
// ────────────────────────────────────────────────────────────
describe('share', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nativeShare uses navigator.share on web when available', async () => {
    const shareFn = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share: shareFn });

    const result = await nativeShare({ title: 'Loop', text: 'Check out Loop!' });

    expect(result).toBe(true);
    expect(shareFn).toHaveBeenCalledWith({ title: 'Loop', text: 'Check out Loop!' });
  });

  it('nativeShare returns false when navigator.share is not available', async () => {
    Object.assign(navigator, { share: undefined });

    const result = await nativeShare({ title: 'Loop', text: 'Check out Loop!' });

    expect(result).toBe(false);
  });

  it('nativeShare returns false on error', async () => {
    Object.assign(navigator, {
      share: vi.fn().mockRejectedValue(new Error('User cancelled')),
    });

    const result = await nativeShare({ title: 'Loop', text: 'Check out Loop!' });

    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 10. Biometrics
// ────────────────────────────────────────────────────────────
describe('biometrics', () => {
  it('checkBiometrics returns { available: false, biometryType: "none" } on web', async () => {
    const result = await checkBiometrics();
    expect(result).toEqual({ available: false, biometryType: 'none' });
  });

  it('authenticateWithBiometrics returns false on web', async () => {
    const result = await authenticateWithBiometrics('Unlock Loop');
    expect(result).toBe(false);
  });

  it('authenticateWithBiometrics returns false regardless of reason', async () => {
    const result = await authenticateWithBiometrics('Confirm purchase');
    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 11. App Lock
// ────────────────────────────────────────────────────────────
describe('app-lock', () => {
  it('isAppLockEnabled returns false on web', async () => {
    const result = await isAppLockEnabled();
    expect(result).toBe(false);
  });

  it('setAppLockEnabled is a no-op on web', async () => {
    await expect(setAppLockEnabled(true)).resolves.toBeUndefined();
  });

  it('setAppLockEnabled(false) is also a no-op on web', async () => {
    await expect(setAppLockEnabled(false)).resolves.toBeUndefined();
  });

  it('registerAppLockGuard returns a cleanup function on web', () => {
    const cleanup = registerAppLockGuard();
    expect(typeof cleanup).toBe('function');
  });

  it('registerAppLockGuard cleanup is a no-op on web', () => {
    const cleanup = registerAppLockGuard();
    expect(() => cleanup()).not.toThrow();
  });

  it('registerAppLockGuard does not register resume event listener on web', () => {
    mockDocument.addEventListener.mockClear();
    registerAppLockGuard();
    const resumeCall = mockDocument.addEventListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'resume',
    );
    expect(resumeCall).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 12. WebView
// ────────────────────────────────────────────────────────────
describe('webview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up window.open mock
    delete (window as unknown as Record<string, unknown>).open;
  });

  it('opens URL in new tab on web', async () => {
    const mockWin = { close: vi.fn(), closed: false };
    const openFn = vi.fn(() => mockWin);
    (window as unknown as Record<string, unknown>).open = openFn;

    const controller = await openWebView({ url: 'https://example.com' });

    expect(openFn).toHaveBeenCalledWith('https://example.com', '_blank');
    expect(controller).toHaveProperty('close');
  });

  it('close() calls window.close on the opened tab', async () => {
    const mockWin = { close: vi.fn(), closed: false };
    (window as unknown as Record<string, unknown>).open = vi.fn(() => mockWin);

    const controller = await openWebView({ url: 'https://example.com' });
    await controller.close();

    expect(mockWin.close).toHaveBeenCalled();
  });

  it('calls onClose when the opened tab is closed', async () => {
    vi.useFakeTimers();
    const mockWin = { close: vi.fn(), closed: false };
    (window as unknown as Record<string, unknown>).open = vi.fn(() => mockWin);

    const onClose = vi.fn();
    await openWebView({ url: 'https://example.com', onClose });

    // Tab is still open
    vi.advanceTimersByTime(1500);
    expect(onClose).not.toHaveBeenCalled();

    // Tab closes
    mockWin.closed = true;
    vi.advanceTimersByTime(1500);
    expect(onClose).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('ignores scripts on web (no injection capability)', async () => {
    const mockWin = { close: vi.fn(), closed: false };
    (window as unknown as Record<string, unknown>).open = vi.fn(() => mockWin);

    // Should not throw even with scripts provided
    const controller = await openWebView({
      url: 'https://example.com',
      scripts: ['console.log("injected")'],
    });

    expect(controller).toHaveProperty('close');
  });
});
