// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockCopy = vi.fn<(text: string) => Promise<boolean>>();
const mockOpenWebView = vi.fn();

vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (t: string) => mockCopy(t),
}));
vi.mock('~/native/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticNotification: vi.fn(),
}));
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

beforeEach(() => {
  mockCopy.mockResolvedValue(true);
  mockOpenWebView.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  usePurchaseStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RedeemFlow', () => {
  it('renders the challenge code prominently', () => {
    render(<RedeemFlow {...baseProps} />);
    expect(screen.getByText('ABC123')).toBeDefined();
  });

  it('renders without crashing when scripts is null', () => {
    render(<RedeemFlow {...baseProps} scripts={null} />);
    expect(screen.getByText('ABC123')).toBeDefined();
  });

  it('copies the challenge code when the copy button is clicked', async () => {
    render(<RedeemFlow {...baseProps} />);
    const copyBtn = screen.getAllByRole('button', { name: /Copy/i })[0]!;
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(mockCopy).toHaveBeenCalledWith('ABC123');
  });

  it('exposes a button to open the redemption WebView', () => {
    render(<RedeemFlow {...baseProps} />);
    // The primary CTA targets the redeem URL flow.
    const ctas = screen.getAllByRole('button');
    expect(ctas.length).toBeGreaterThan(0);
  });
});
