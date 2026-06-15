// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApiException } from '@loop/shared';

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

describe('PaymentStep — retry budget (audit A-030)', () => {
  it('stops polling and sets an error after MAX_CONSECUTIVE_ERRORS failures', async () => {
    // Every fetch rejects with a 500 — the counter must climb until the
    // 5th failure, at which point polling stops and an error is surfaced.
    mockFetchOrder.mockRejectedValue(
      new ApiException(500, { code: 'UPSTREAM_ERROR', message: 'boom' }),
    );
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);

    // Six full poll intervals — well past the 5-error budget. Each
    // advance triggers setTimeout → poll() → setTimeout (reschedule),
    // so we drain microtasks between ticks.
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(mockFetchOrder).toHaveBeenCalledTimes(5);
    const err = usePurchaseStore.getState().error;
    expect(err).toMatch(/trouble checking your payment/);
  });

  it('does not count 503 (circuit-breaker open) against the budget', async () => {
    // 503s are issued by the upstream circuit breaker, which has its own
    // cooldown. If we counted each against the budget, 5 probe-attempts
    // would nuke the polling even though the breaker is already pacing
    // retries correctly. Verify the counter stays at 0 after five 503s.
    mockFetchOrder.mockRejectedValue(
      new ApiException(503, { code: 'SERVICE_UNAVAILABLE', message: 'open' }),
    );
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);

    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Polling continued past the would-be budget — error should NOT be set.
    expect(usePurchaseStore.getState().error).toBeNull();
    expect(mockFetchOrder.mock.calls.length).toBeGreaterThan(5);
  });
});

describe('PaymentStep — copy-to-clipboard', () => {
  it('copies the payment address when its copy button is clicked', async () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    const copyAddressButton = screen.getByRole('button', { name: /copy payment address/i });
    await act(async () => {
      fireEvent.click(copyAddressButton);
    });
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockCopy).toHaveBeenCalledWith(baseProps.paymentAddress);
  });

  it('copies the memo when its copy button is clicked', async () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    const copyMemoButton = screen.getByRole('button', { name: /copy required memo/i });
    await act(async () => {
      fireEvent.click(copyMemoButton);
    });
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockCopy).toHaveBeenCalledWith(baseProps.memo);
  });

  // A11Y-003 / CF-35: the memo-strand bug. A single shared `copied` boolean
  // used to flip BOTH copy buttons to "Copied!" — making a user believe they
  // copied the memo when they only copied the address (Stellar payment with
  // a wrong/absent memo strands funds at CTX). Each button must own its state.
  it('copying the address does NOT flip the memo button to "Copied!"', async () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    const copyAddressButton = screen.getByRole('button', { name: /copy payment address/i });
    await act(async () => {
      fireEvent.click(copyAddressButton);
    });
    // Address confirms; memo button keeps its idle label.
    expect(copyAddressButton.textContent).toBe('Copied!');
    expect(screen.getByRole('button', { name: /copy required memo/i }).textContent).toBe(
      'Copy memo',
    );
  });

  it('copying the memo does NOT flip the address button to "Copied!"', async () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    const copyMemoButton = screen.getByRole('button', { name: /copy required memo/i });
    await act(async () => {
      fireEvent.click(copyMemoButton);
    });
    expect(copyMemoButton.textContent).toBe('Copied!');
    expect(screen.getByRole('button', { name: /copy payment address/i }).textContent).toBe(
      'Copy address',
    );
  });
});

describe('PaymentStep — WCAG 2.2.1 timing (CF-35)', () => {
  it('offers an explicit start-over affordance before the window expires', () => {
    render(<PaymentStep {...baseProps} expiresAt={Math.floor(Date.now() / 1000) + 600} />);
    expect(
      screen.getByRole('button', { name: /start over with a fresh payment window/i }),
    ).toBeTruthy();
  });
});
