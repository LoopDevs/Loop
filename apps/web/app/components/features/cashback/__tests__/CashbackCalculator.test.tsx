// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PublicStats from '~/services/public-stats';
import { CashbackCalculator, formatCashbackMinor } from '../CashbackCalculator';

afterEach(cleanup);

const { mocks } = vi.hoisted(() => ({
  mocks: { getPublicCashbackPreview: vi.fn() },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStats;
  return {
    ...actual,
    getPublicCashbackPreview: (args: { merchantId: string; amountMinor: number }) =>
      mocks.getPublicCashbackPreview(args),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCalculator(merchantId = 'amazon-us'): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <CashbackCalculator merchantId={merchantId} />
    </QueryClientProvider>,
  );
  return container;
}

describe('formatCashbackMinor', () => {
  it('renders minor-units bigint strings as localised currency', () => {
    expect(formatCashbackMinor('250', 'USD')).toBe('$2.50');
    expect(formatCashbackMinor('1000', 'GBP')).toBe('£10.00');
  });

  it('returns em-dash on malformed input', () => {
    expect(formatCashbackMinor('not-a-number', 'USD')).toBe('—');
  });
});

describe('<CashbackCalculator />', () => {
  it('renders projected cashback after the initial debounce', async () => {
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: '5000', // $50 default
      cashbackPct: '2.50',
      cashbackMinor: '125',
      currency: 'USD',
    });
    renderCalculator();
    // The heading renders immediately.
    expect(screen.getByText('Calculate your cashback')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText('$1.25')).toBeDefined();
    });
    expect(screen.getByText(/2\.50%/)).toBeDefined();
  });

  it('renders em-dash when the merchant has no active cashback config', async () => {
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: '5000',
      cashbackPct: null,
      cashbackMinor: '0',
      currency: 'USD',
    });
    renderCalculator();
    await waitFor(() => {
      expect(mocks.getPublicCashbackPreview).toHaveBeenCalled();
    });
    // Em-dashes appear for both the Rate + You'll earn columns.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('refetches with a new amountMinor after the debounce settles', async () => {
    mocks.getPublicCashbackPreview.mockImplementation(async (args) => ({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: String(args.amountMinor),
      cashbackPct: '5.00',
      cashbackMinor: String(Math.floor((args.amountMinor * 500) / 10_000)),
      currency: 'USD',
    }));
    renderCalculator();
    // Initial debounce fires with 5000 (=$50).
    await waitFor(() => {
      expect(mocks.getPublicCashbackPreview).toHaveBeenCalledWith({
        merchantId: 'amazon-us',
        amountMinor: 5000,
      });
    });
    // Type a new amount: $200.
    const input = screen.getByLabelText(/Gift card amount/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '200' } });
    // After the debounce + fetch, the $10 cashback should appear.
    await waitFor(() => {
      expect(screen.getByText('$10.00')).toBeDefined();
    });
    expect(mocks.getPublicCashbackPreview).toHaveBeenCalledWith({
      merchantId: 'amazon-us',
      amountMinor: 20_000,
    });
  });

  it('skips the fetch when the amount is zero', async () => {
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: '0',
      cashbackPct: null,
      cashbackMinor: '0',
      currency: 'USD',
    });
    renderCalculator();
    const input = screen.getByLabelText(/Gift card amount/i) as HTMLInputElement;
    // Immediately change to 0 before the initial debounce fires —
    // the final debounced value is 0, `enabled` goes false, no fetch.
    fireEvent.change(input, { target: { value: '0' } });
    // Let the debounce + any queued useEffect flush.
    await new Promise((r) => setTimeout(r, 400));
    // The initial render with default $50 may have fired once; after
    // the 0 change the query stays disabled. Assert the last known
    // amountMinor was a non-zero call OR the mock was never called —
    // either is fine, we're checking we DON'T fire a fetch for 0.
    for (const call of mocks.getPublicCashbackPreview.mock.calls) {
      expect((call[0] as { amountMinor: number }).amountMinor).toBeGreaterThan(0);
    }
  });
});
