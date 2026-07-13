// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
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
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: 'o-1',
    merchantId: 'm1',
    state: 'fulfilled',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO',
    stellarAddress: null,
    assetAmount: null,
    paymentUri: null,
    assetCode: null,
    assetIssuer: null,
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
    expect(screen.getAllByText(/\$10\.00/).length).toBe(2);
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

  it('surfaces earned cashback on the always-visible row for fulfilled orders', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ userCashbackMinor: '250', currency: 'GBP' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    // `250` minor = `2.50` major — rendered with a leading `+` and the
    // order's currency symbol (WEB-M2) so a GBP credit reads as `£2.50`,
    // not ambiguously as `2.50` (which could be $ or £).
    expect(screen.getByText('+£2.50 cashback')).toBeDefined();
  });

  it('hides the cashback pill when userCashbackMinor is zero', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ userCashbackMinor: '0' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.queryByText(/cashback$/i)).toBeNull();
  });

  it('hides the cashback pill on an unfulfilled order even if minor is non-zero', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ state: 'pending_payment', userCashbackMinor: '250' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.queryByText(/\+2\.50 cashback/)).toBeNull();
  });

  it('shows the "Recycled" pill when paymentMethod is loop_asset', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ paymentMethod: 'loop_asset' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.getByLabelText(/Paid with recycled cashback/i)).toBeDefined();
    expect(screen.getByText(/Recycled/)).toBeDefined();
  });

  it('renders the Recycled pill regardless of order state (intent signal, not outcome)', async () => {
    // A pending loop_asset order — user has declared intent to
    // recycle even if the order hasn't settled yet.
    listMock.mockResolvedValue({
      orders: [mkOrder({ paymentMethod: 'loop_asset', state: 'pending_payment' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.getByLabelText(/Paid with recycled cashback/i)).toBeDefined();
  });

  it('hides the "Recycled" pill for non-loop_asset orders', async () => {
    listMock.mockResolvedValue({
      orders: [mkOrder({ paymentMethod: 'usdc' })],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.queryByLabelText(/Paid with recycled cashback/i)).toBeNull();
  });

  it('A4-026: pending_payment row auto-expands and exposes deposit address + memo for recovery', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({
          state: 'pending_payment',
          paymentMemo: 'MEMO-RECOVERY',
          stellarAddress: 'GABCDEF',
          chargeMinor: '2500',
          chargeCurrency: 'USD',
          paymentMethod: 'usdc',
          redeemCode: null,
          redeemPin: null,
        }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    // Auto-expanded — no click required.
    await waitFor(() => screen.getByText('MEMO-RECOVERY'));
    expect(screen.getByText('GABCDEF')).toBeDefined();
    expect(screen.getByText(/Send \$25\.00 of USDC/i)).toBeDefined();
  });

  it('A4-026: pending_payment without stellarAddress / memo renders no panel (no NPE)', async () => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({
          state: 'pending_payment',
          paymentMemo: null,
          stellarAddress: null,
          redeemCode: null,
          redeemPin: null,
        }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    await waitFor(() => screen.getByText('Target'));
    expect(screen.queryByText(/Send /i)).toBeNull();
  });

  // WUM-10 (2026-06-30 cold audit): CF-35's aria-live copy-confirmation
  // pattern rolled out from LoopPaymentStep's Row to RedemptionField —
  // this component is that Row's structural sibling in the orders list.
  it('WUM-10: announces the copied field to assistive tech, then resets', async () => {
    vi.useFakeTimers();
    listMock.mockResolvedValue({ orders: [mkOrder()] });
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(wrap(<LoopOrdersList enabled={true} />));
    const toggle = await vi.waitFor(() => screen.getByRole('button', { name: /Target/ }));
    fireEvent.click(toggle);
    const copyCode = await vi.waitFor(() => screen.getByRole('button', { name: /Copy code/i }));
    fireEvent.click(copyCode);
    await vi.waitFor(() => {
      expect(screen.getByText('Code copied to clipboard.')).toBeDefined();
    });
    vi.advanceTimersByTime(1_500);
    await vi.waitFor(() => {
      expect(screen.queryByText('Code copied to clipboard.')).toBeNull();
    });
    vi.useRealTimers();
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

  // P2-03 (XSS): a redeemUrl is server/upstream-supplied. Dropped into an
  // `<a href>` unvalidated, a `javascript:` scheme executes on click —
  // with app privileges inside the Capacitor native WebView. The scheme
  // must be gated so a dangerous URL is neutralized to "no live link".
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
  ])('does NOT render a %s redeemUrl as a live href', async (_scheme, redeemUrl) => {
    listMock.mockResolvedValue({
      orders: [
        mkOrder({
          redeemCode: null,
          redeemPin: null,
          redeemUrl,
        }),
      ],
    });
    render(wrap(<LoopOrdersList enabled={true} />));
    const toggle = await waitFor(() => screen.getByRole('button', { name: /Target/ }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    // The dangerous scheme is dropped — no redemption anchor at all.
    expect(screen.queryByRole('link', { name: /Open redemption link/i })).toBeNull();
    // Belt-and-braces: the raw payload never reaches any href attribute.
    for (const anchor of document.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).not.toBe(redeemUrl);
    }
  });
});
