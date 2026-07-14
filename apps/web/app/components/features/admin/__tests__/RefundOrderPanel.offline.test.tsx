// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { useAuthStore } from '~/stores/auth.store';
import { RefundOrderPanel } from '../RefundOrderPanel';

// A refund is a non-idempotent-feeling money write. The offline guard
// (FE-43) disables the "Refund order" entry button while the device is
// offline, so a connectivity flap can't fire (or double-fire) the POST.
// `~/native/network` is deliberately NOT mocked — the real web
// `watchNetwork` path (navigator.onLine + online/offline events) drives
// `useOnline()` end to end, matching PayWithLoopBalance.offline.test.

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any import
// pulls the store in (vi.hoisted runs pre-import).
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

const { adminMock, staffRoleMock, stepUpMock } = vi.hoisted(() => ({
  adminMock: { refundOrder: vi.fn() },
  staffRoleMock: {
    value: {
      staffRole: 'admin' as 'admin' | 'support' | null,
      isAdminRole: true,
      isStaff: true,
      isPending: false,
    },
  },
  stepUpMock: { requestOtp: vi.fn(), mintAdminStepUp: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    refundOrder: (args: unknown) => adminMock.refundOrder(args),
  };
});

vi.mock('~/hooks/use-staff-role', () => ({
  useStaffRole: () => staffRoleMock.value,
}));

vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => stepUpMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));

beforeEach(() => {
  adminMock.refundOrder.mockReset();
  staffRoleMock.value = {
    staffRole: 'admin',
    isAdminRole: true,
    isStaff: true,
    isPending: false,
  };
  useUiStore.setState({ toasts: [] });
  useAuthStore.setState({ email: 'admin@loop.test' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

function renderPanel(orderState = 'paid'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RefundOrderPanel orderId="ord-1" orderState={orderState} />
    </QueryClientProvider>,
  );
}

describe('<RefundOrderPanel /> — offline gating (FE-43)', () => {
  it('disables the Refund order button on network loss and re-enables it on reconnect', () => {
    renderPanel('paid');

    const button = screen.getByRole('button', { name: /Refund order/i });
    // Baseline: online → enabled.
    expect(button.hasAttribute('disabled')).toBe(false);

    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });

    // Disabled, with a spoken-aloud reason wired to the button for AT.
    expect(button.hasAttribute('disabled')).toBe(true);
    const hint = screen.getByText(/You.re offline/);
    expect(hint.textContent).toMatch(/reconnect to refund/i);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/You.re offline/)).toBeNull();
  });
});
