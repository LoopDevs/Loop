// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as OrdersLoopModule from '~/services/orders-loop';
import type { LoopOrderView } from '~/services/orders-loop';

const listMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    listLoopOrders: () => listMock(),
  };
});

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({
    merchants: [{ id: 'm1', name: 'Target', enabled: true }],
  }),
}));

import { LoopOrdersList } from '../LoopOrdersList';

function wrap(ui: React.ReactElement): React.JSX.Element {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: 'o-1',
    merchantId: 'm1',
    state: 'fulfilled',
    faceValueMinor: '1000',
    currency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO',
    stellarAddress: null,
    userCashbackMinor: '50',
    ctxOrderId: 'ctx-1',
    redeemCode: 'GIFT-123',
    redeemPin: '4242',
    redeemUrl: null,
    failureReason: null,
    createdAt: '2026-04-21T12:00:00Z',
    paidAt: '2026-04-21T12:01:00Z',
    fulfilledAt: '2026-04-21T12:05:00Z',
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
});
afterEach(cleanup);

describe('LoopOrdersList', () => {
  it('renders null when the flag is off — no fetch', () => {
    const { container } = render(wrap(<LoopOrdersList enabled={false} />));
    expect(container.firstChild).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('renders null when the list is empty', async () => {
    listMock.mockResolvedValue({ orders: [] });
    const { container } = render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // The section's root is null for empty lists.
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows a row per order with merchant + amount + state pill', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ id: 'o-1' }), mkOrder({ id: 'o-2', state: 'pending_payment' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getAllByText('Target'));
    expect(screen.getAllByText('Target').length).toBe(2);
    expect(screen.getAllByText(/10\.00 USD/).length).toBe(2);
    expect(screen.getByText('Ready')).toBeDefined();
    expect(screen.getByText('Waiting for payment')).toBeDefined();
  });

  it('expands on click and reveals the code/PIN with copy buttons', async () => {
    listMock.mockResolvedValue({ orders: [mkOrder()] });
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(wrap(<LoopOrdersList enabled={true} />));
    const toggle = await waitFor(() => screen.getByRole('button', { name: /Target/ }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByText('GIFT-123')).toBeDefined();
    expect(screen.getByText('4242')).toBeDefined();
    const copyCode = screen.getByRole('button', { name: /Copy code/i });
    await act(async () => {
      fireEvent.click(copyCode);
    });
    expect(writeText).toHaveBeenCalledWith('GIFT-123');
  });

  it('surfaces the failure reason when state=failed', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({
          state: 'failed',
          redeemCode: null,
          redeemPin: null,
          failureReason: 'CTX returned 500',
        }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    const toggle = await waitFor(() => screen.getByRole('button', { name: /Target/ }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByText('CTX returned 500')).toBeDefined();
  });

  it('shows the redeem URL anchor with noopener when present', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({
          redeemCode: null,
          redeemPin: null,
          redeemUrl: 'https://redeem.example.com/z',
        }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    const toggle = await waitFor(() => screen.getByRole('button', { name: /Target/ }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    const link = screen.getByRole('link', { name: /Open redemption link/i });
    expect(link.getAttribute('href')).toBe('https://redeem.example.com/z');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });
});
