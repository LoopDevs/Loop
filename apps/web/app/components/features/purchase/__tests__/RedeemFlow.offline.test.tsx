// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// Opening the merchant redemption page is a network action; the offline
// guard (FE-43) disables it while the device is offline. We stub the native
// bridges but deliberately DO NOT mock `~/native/network` — the real web
// `watchNetwork` path (navigator.onLine + online/offline events) is what
// drives `useOnline()` here, exactly like PayWithLoopBalance.offline.test.
vi.mock('~/native/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
vi.mock('~/native/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticNotification: vi.fn(),
}));
const mockOpenWebView = vi.fn();
vi.mock('~/native/webview', () => ({
  openWebView: (...args: unknown[]) => mockOpenWebView(...args),
}));

import { RedeemFlow } from '../RedeemFlow';
import { usePurchaseStore } from '~/stores/purchase.store';

const baseProps = {
  merchantName: 'Target',
  redeemUrl: 'https://provider.com/redeem',
  challengeCode: 'ABC123',
  scripts: null,
};

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

beforeEach(() => {
  mockOpenWebView.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  usePurchaseStore.getState().reset();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('RedeemFlow — offline gating (FE-43)', () => {
  it('disables the open-redemption button on network loss and re-enables it on reconnect', () => {
    render(<RedeemFlow {...baseProps} />);

    const button = screen.getByRole('button', { name: /Open redemption page/i });
    // Baseline: online → enabled.
    expect(button.hasAttribute('disabled')).toBe(false);

    // Go offline: navigator.onLine=false + the browser 'offline' event.
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });

    // Disabled, with a spoken-aloud reason wired to the button for AT.
    expect(button.hasAttribute('disabled')).toBe(true);
    const hint = screen.getByText(/You.re offline/);
    expect(hint.textContent).toMatch(/reconnect to open the redemption page/i);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    // Back online → enabled again, offline hint gone.
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/You.re offline/)).toBeNull();
  });
});
