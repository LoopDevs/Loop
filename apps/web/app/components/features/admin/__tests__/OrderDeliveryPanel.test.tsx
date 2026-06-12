// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminRefetchRedemptionResult } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { OrderDeliveryPanel } from '../OrderDeliveryPanel';

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any
// import pulls the store in (vi.hoisted runs pre-import).
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

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    refetchOrderRedemption: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    refetchOrderRedemption: (orderId: string) => adminMock.refetchOrderRedemption(orderId),
  };
});

beforeEach(() => {
  adminMock.refetchOrderRedemption.mockReset();
  useUiStore.setState({ toasts: [] });
});

function renderPanel(orderState = 'fulfilled'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OrderDeliveryPanel orderId="ord-1" orderState={orderState} />
    </QueryClientProvider>,
  );
}

async function clickRefetch(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Refetch redemption/i }));
  });
}

describe('<OrderDeliveryPanel />', () => {
  it('self-hides for non-fulfilled orders', () => {
    renderPanel('procuring');
    expect(screen.queryByText(/Delivery \/ redemption/i)).toBeNull();
  });

  it('starts with the "not checked" status pill', () => {
    renderPanel();
    expect(screen.getByText(/redemption not checked/i)).toBeDefined();
  });

  it('refetch → service called → success toast + "present" pill', async () => {
    adminMock.refetchOrderRedemption.mockResolvedValue({
      refetched: true,
      redemptionPresent: true,
    } satisfies AdminRefetchRedemptionResult);
    renderPanel();
    await clickRefetch();
    await waitFor(() => {
      expect(adminMock.refetchOrderRedemption).toHaveBeenCalledWith('ord-1');
    });
    await waitFor(() => {
      expect(screen.getByText(/redemption present/i)).toBeDefined();
    });
    expect(
      useUiStore
        .getState()
        .toasts.some((t) => t.type === 'success' && /customer can redeem now/i.test(t.message)),
    ).toBe(true);
  });

  it('reports already-present material without a refetch', async () => {
    adminMock.refetchOrderRedemption.mockResolvedValue({
      refetched: false,
      redemptionPresent: true,
    } satisfies AdminRefetchRedemptionResult);
    renderPanel();
    await clickRefetch();
    await waitFor(() => {
      expect(useUiStore.getState().toasts.some((t) => /already present/i.test(t.message))).toBe(
        true,
      );
    });
  });

  it('still-missing redemption lands as an error toast + "missing" pill', async () => {
    adminMock.refetchOrderRedemption.mockResolvedValue({
      refetched: true,
      redemptionPresent: false,
    } satisfies AdminRefetchRedemptionResult);
    renderPanel();
    await clickRefetch();
    await waitFor(() => {
      expect(screen.getByText(/redemption missing/i)).toBeDefined();
    });
    expect(
      useUiStore
        .getState()
        .toasts.some((t) => t.type === 'error' && /still missing/i.test(t.message)),
    ).toBe(true);
  });

  it('surfaces a transport failure as an error toast and keeps "not checked"', async () => {
    adminMock.refetchOrderRedemption.mockRejectedValue(
      new ApiException(502, { code: 'UPSTREAM_ERROR', message: 'CTX unreachable' }),
    );
    renderPanel();
    await clickRefetch();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /CTX unreachable/.test(t.message)),
      ).toBe(true);
    });
    expect(screen.getByText(/redemption not checked/i)).toBeDefined();
  });
});
