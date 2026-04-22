// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { RailMixCard } from '../RailMixCard';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserPaymentMethodShare: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserPaymentMethodShare: (opts?: { state?: UserModule.UserOrderState }) =>
      userMock.getUserPaymentMethodShare(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RailMixCard />
    </QueryClientProvider>,
  );
}

describe('<RailMixCard />', () => {
  it('self-hides (returns null) on zero-orders', async () => {
    userMock.getUserPaymentMethodShare.mockResolvedValue({
      currency: 'GBP',
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: {
        loop_asset: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        xlm: { orderCount: 0, chargeMinor: '0' },
      },
    });
    const { container } = renderCard();
    await waitFor(() => {
      // Component returns null — no card header rendered.
      expect(container.querySelector('section')).toBeNull();
    });
  });

  it('renders four rails with counts and % columns when user has orders', async () => {
    userMock.getUserPaymentMethodShare.mockResolvedValue({
      currency: 'GBP',
      state: 'fulfilled',
      totalOrders: 20,
      byMethod: {
        loop_asset: { orderCount: 10, chargeMinor: '4000' },
        credit: { orderCount: 3, chargeMinor: '1200' },
        usdc: { orderCount: 5, chargeMinor: '2000' },
        xlm: { orderCount: 2, chargeMinor: '800' },
      },
    });
    renderCard();
    // "LOOP asset" also appears in the header copy — use
    // getAllByText and assert both (header + pill) are rendered.
    await waitFor(() => {
      expect(screen.getAllByText('LOOP asset').length).toBe(2);
    });
    expect(screen.getByText('Credit balance')).toBeDefined();
    expect(screen.getByText('USDC')).toBeDefined();
    expect(screen.getByText('XLM')).toBeDefined();
    // loop_asset: 10/20 = 50.0% by count, 4000/8000 = 50.0% by charge.
    expect(screen.getAllByText(/50\.0%/).length).toBeGreaterThan(0);
    // Per-currency copy references home currency.
    expect(screen.getByText(/fulfilled orders in GBP/)).toBeDefined();
  });

  it('silent-hides on fetch failure (not a dashboard surface)', async () => {
    userMock.getUserPaymentMethodShare.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
    // No error text either.
    expect(screen.queryByText(/Failed/)).toBeNull();
  });
});
