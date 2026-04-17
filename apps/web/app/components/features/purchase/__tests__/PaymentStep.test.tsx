// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockFetchOrder = vi.fn<(id: string) => Promise<Record<string, unknown>>>();
const mockCopy = vi.fn<(text: string) => Promise<boolean>>();

vi.mock('~/services/orders', () => ({
  fetchOrder: (id: string) => mockFetchOrder(id),
}));
vi.mock('~/native/clipboard', () => ({
  copyToClipboard: (t: string) => mockCopy(t),
}));
// QR generation is dynamically imported; stub to a tiny data URL.
vi.mock('qrcode', () => ({
  toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
}));

import { PaymentStep } from '../PaymentStep';
import { usePurchaseStore } from '~/stores/purchase.store';

const baseProps = {
  merchantName: 'Target',
  paymentAddress: 'GXXX',
  xlmAmount: '12.5',
  orderId: 'o-1',
  memo: 'ctx:memo',
};

beforeEach(() => {
  mockCopy.mockResolvedValue(true);
  mockFetchOrder.mockResolvedValue({ id: 'o-1', status: 'pending' });
  usePurchaseStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('PaymentStep — rendering', () => {
  it('shows the merchant-specific copy', () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    // Merchant name is present in the UI for context.
    expect(screen.getAllByText(/Target/i).length).toBeGreaterThan(0);
  });

  it('shows the XLM amount', () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    expect(screen.getAllByText(/12\.5/).length).toBeGreaterThan(0);
  });

  it('shows the payment address', () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    expect(screen.getAllByText(/GXXX/).length).toBeGreaterThan(0);
  });
});

describe('PaymentStep — expiry', () => {
  it('renders an expired UI when expiresAt is in the past', () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) - 10} />);
    expect(screen.getAllByText(/expired/i).length).toBeGreaterThan(0);
  });
});

describe('PaymentStep — copy-to-clipboard', () => {
  it('copies the payment address when its copy button is clicked', async () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    // Address section has a Copy button; click the first one available.
    const copyButtons = screen.getAllByRole('button', { name: /Copy/i });
    expect(copyButtons.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(copyButtons[0]!);
    });
    expect(mockCopy).toHaveBeenCalled();
  });
});
