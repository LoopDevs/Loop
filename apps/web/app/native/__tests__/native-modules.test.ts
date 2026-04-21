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
import { triggerHaptic, triggerHapticMedium, triggerHapticNotification } from '../haptics';
import {
  storeRefreshToken,
  getRefreshToken,
  clearRefreshToken,
  storeEmail,
  getEmail,
} from '../secure-storage';
import { setupNotificationChannels } from '../notifications';
import { setStatusBarStyle, setStatusBarOverlay } from '../status-bar';
import { registerBackButton } from '../back-button';
import { watchNetwork } from '../network';
import { enableScreenshotGuard } from '../screenshot-guard';
import { nativeShare } from '../share';
import { checkBiometrics, authenticateWithBiometrics } from '../biometrics';
import { isAppLockEnabled, setAppLockEnabled, registerAppLockGuard } from '../app-lock';
import { openWebView } from '../webview';
import { savePendingOrder, loadPendingOrder, clearPendingOrder } from '../purchase-storage';

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

  it('triggerHapticMedium is a no-op on web', async () => {
    await expect(triggerHapticMedium()).resolves.toBeUndefined();
  });

  it('triggerHapticNotification is a no-op on web', async () => {
    await expect(triggerHapticNotification('success')).resolves.toBeUndefined();
  });

  it('triggerHapticNotification accepts warning and error variants', async () => {
    await expect(triggerHapticNotification('warning')).resolves.toBeUndefined();
    await expect(triggerHapticNotification('error')).resolves.toBeUndefined();
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

  it('storeEmail persists email to sessionStorage on web', async () => {
    await storeEmail('user@example.com');
    expect(mockSessionStorage.store.get('loop_user_email')).toBe('user@example.com');
  });

  it('getEmail reads email from sessionStorage on web', async () => {
    mockSessionStorage.store.set('loop_user_email', 'restored@example.com');
    const email = await getEmail();
    expect(email).toBe('restored@example.com');
  });

  it('getEmail returns null when no email is stored', async () => {
    const email = await getEmail();
    expect(email).toBeNull();
  });

  it('clearRefreshToken also clears the stored email (single logout action)', async () => {
    mockSessionStorage.store.set('loop_refresh_token', 'rt');
    mockSessionStorage.store.set('loop_user_email', 'u@example.com');
    await clearRefreshToken();
    expect(mockSessionStorage.store.has('loop_refresh_token')).toBe(false);
    expect(mockSessionStorage.store.has('loop_user_email')).toBe(false);
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

  it('registerBackButton returns a disposer on web (no-op function)', () => {
    // Now returns a cleanup fn so callers can remove the Capacitor
    // listener on unmount. On web (non-Capacitor) it's a no-op, but
    // calling it must still be safe.
    const dispose = registerBackButton();
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
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

  it('opens URL in new tab on web with noopener,noreferrer (tabnabbing defense)', async () => {
    const mockWin = { close: vi.fn(), closed: false };
    const openFn = vi.fn(() => mockWin);
    (window as unknown as Record<string, unknown>).open = openFn;

    const controller = await openWebView({ url: 'https://example.com' });

    expect(openFn).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(controller).toHaveProperty('close');
  });

  it('rejects javascript: URLs before opening', async () => {
    const openFn = vi.fn();
    (window as unknown as Record<string, unknown>).open = openFn;

    await expect(openWebView({ url: 'javascript:alert(1)' })).rejects.toThrow(
      /only http\(s\) URLs/,
    );
    expect(openFn).not.toHaveBeenCalled();
  });

  it('rejects file: and data: URLs before opening', async () => {
    const openFn = vi.fn();
    (window as unknown as Record<string, unknown>).open = openFn;

    await expect(openWebView({ url: 'file:///etc/passwd' })).rejects.toThrow(/only http\(s\)/);
    await expect(openWebView({ url: 'data:text/html,<script>alert(1)</script>' })).rejects.toThrow(
      /only http\(s\)/,
    );
    expect(openFn).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs', async () => {
    const openFn = vi.fn();
    (window as unknown as Record<string, unknown>).open = openFn;

    await expect(openWebView({ url: 'not a url' })).rejects.toThrow(/invalid URL/);
    expect(openFn).not.toHaveBeenCalled();
  });

  // Audit A-009 — in dev/test we allow http:// so the mocked suites work;
  // production builds must refuse plain http to keep a MITM from swapping
  // the redeem target.
  it('accepts http:// URLs in dev/test builds', async () => {
    const mockWin = { close: vi.fn(), closed: false };
    (window as unknown as Record<string, unknown>).open = vi.fn(() => mockWin);
    const controller = await openWebView({ url: 'http://redeem.test/abc' });
    expect(controller).toHaveProperty('close');
  });

  it('refuses http:// URLs when `import.meta.env.PROD` is true (regression A-009)', async () => {
    const openFn = vi.fn();
    (window as unknown as Record<string, unknown>).open = openFn;
    vi.stubEnv('PROD', true);
    try {
      await expect(openWebView({ url: 'http://redeem.test/abc' })).rejects.toThrow(
        /rejected in production/,
      );
      expect(openFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects URLs with embedded credentials (phishing vector)', async () => {
    const openFn = vi.fn();
    (window as unknown as Record<string, unknown>).open = openFn;

    await expect(openWebView({ url: 'https://user:pass@redeem.test/abc' })).rejects.toThrow(
      /embedded credentials/,
    );
    await expect(openWebView({ url: 'https://user@redeem.test/abc' })).rejects.toThrow(
      /embedded credentials/,
    );
    expect(openFn).not.toHaveBeenCalled();
  });

  it('surfaces popup-blocker rejection when window.open returns null', async () => {
    // Popup blockers make window.open return null. Before this fix, the
    // controller was silently a no-op and the caller's "redeeming…" UI
    // stuck forever. Now the caller gets a specific error they can map
    // to a "please allow popups" UX.
    (window as unknown as Record<string, unknown>).open = vi.fn(() => null);
    await expect(openWebView({ url: 'https://example.com' })).rejects.toThrow(/popup blocked/);
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

// ────────────────────────────────────────────────────────────
// 13. Purchase Storage
// ────────────────────────────────────────────────────────────
describe('purchase-storage', () => {
  beforeEach(() => {
    mockSessionStorage.store.clear();
  });

  it('savePendingOrder stores to sessionStorage on web with default expiresAt', async () => {
    const before = Math.floor(Date.now() / 1000);
    await savePendingOrder({ orderId: 'test-123', step: 'payment' });
    const stored = mockSessionStorage.getItem('loop_pending_order');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as Record<string, unknown>;
    expect(parsed.orderId).toBe('test-123');
    expect(parsed.step).toBe('payment');
    // Default expiry is now + 15min. Guard against the footgun where a caller
    // omits expiresAt and loadPendingOrder silently no-ops.
    expect(typeof parsed.expiresAt).toBe('number');
    expect(parsed.expiresAt).toBeGreaterThanOrEqual(before + 14 * 60);
    expect(parsed.expiresAt).toBeLessThanOrEqual(before + 16 * 60);
  });

  it('savePendingOrder preserves caller-provided expiresAt', async () => {
    await savePendingOrder({ orderId: 'x', step: 'payment', expiresAt: 9_999_999_999 });
    const parsed = JSON.parse(mockSessionStorage.getItem('loop_pending_order')!) as Record<
      string,
      unknown
    >;
    expect(parsed.expiresAt).toBe(9_999_999_999);
  });

  it('loadPendingOrder returns data if not expired', async () => {
    const data = { step: 'payment', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    mockSessionStorage.setItem('loop_pending_order', JSON.stringify(data));
    const result = await loadPendingOrder();
    expect(result).toEqual(data);
  });

  it('loadPendingOrder returns null if expired', async () => {
    const data = { step: 'payment', expiresAt: Math.floor(Date.now() / 1000) - 100 };
    mockSessionStorage.setItem('loop_pending_order', JSON.stringify(data));
    const result = await loadPendingOrder();
    expect(result).toBeNull();
  });

  it('loadPendingOrder returns null if no data stored', async () => {
    const result = await loadPendingOrder();
    expect(result).toBeNull();
  });

  it('clearPendingOrder removes from sessionStorage', async () => {
    mockSessionStorage.setItem('loop_pending_order', '{}');
    await clearPendingOrder();
    expect(mockSessionStorage.getItem('loop_pending_order')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 14. Notifications
// ────────────────────────────────────────────────────────────
describe('notifications', () => {
  it('setupNotificationChannels is a no-op on web (resolves without throwing)', async () => {
    await expect(setupNotificationChannels()).resolves.toBeUndefined();
  });
});
