// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
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

// FE-17: mount under a `/:country/:lang` route so `useLocaleTag()` resolves to
// the active market's tag (e.g. `/in/en` → `en-IN`), the same way the app's
// real routes drive `i18n/format` (ADR 034). Without the router the component
// falls back to the home market (en-US), which is what the other tests use.
function renderCalculatorAt(country: string, lang: string, merchantId = 'amazon-us'): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/${country}/${lang}`]}>
        <Routes>
          <Route path="/:country/:lang" element={<CashbackCalculator merchantId={merchantId} />} />
        </Routes>
      </MemoryRouter>
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

  // FE-17: the helper must honour the active locale's grouping instead of
  // always emitting en-US thousands separators. en-IN groups by lakh
  // (`12,34,567.89`) — distinct from en-US (`1,234,567.89`) while keeping the
  // same `$` symbol and `.` decimal, so the ONLY thing under test is that the
  // locale threaded through. Red against the pre-fix helper, which dropped the
  // locale and formatted every user as en-US.
  it('groups by the active locale (en-IN lakh) rather than always en-US', () => {
    // $1,234,567.89 of cashback → en-IN renders it with lakh grouping.
    expect(formatCashbackMinor('123456789', 'USD', 'en-IN')).toBe('$12,34,567.89');
    // Guard the exact failure mode: it must NOT be the en-US grouping.
    expect(formatCashbackMinor('123456789', 'USD', 'en-IN')).not.toBe('$1,234,567.89');
    // The 2-arg call keeps the en-US default (backward compatible).
    expect(formatCashbackMinor('123456789', 'USD')).toBe('$1,234,567.89');
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

  it('renders the projected cashback in the active route locale (en-IN lakh grouping)', async () => {
    // FE-17: a visitor on `/in/en` must see their market's grouping, not the
    // always-en-US separators the calculator baked in. cashbackMinor is large
    // enough that en-IN lakh grouping (`$12,34,567.89`) diverges from the en-US
    // shape (`$1,234,567.89`) — the only difference is the grouping, so a match
    // proves the ROUTE locale drove the format.
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'amazon-us',
      merchantName: 'Amazon',
      orderAmountMinor: '5000',
      cashbackPct: '2.50',
      cashbackMinor: '123456789',
      currency: 'USD',
    });
    renderCalculatorAt('in', 'en');
    await waitFor(() => {
      expect(screen.getByText('$12,34,567.89')).toBeDefined();
    });
    // The en-US grouping must be absent — proves we did not fall back to en-US.
    expect(screen.queryByText('$1,234,567.89')).toBeNull();
  });

  it('shows the merchant currency glyph on the input, not a hardcoded $ (P2-09)', async () => {
    // A UK merchant: currency is GBP, so the input glyph must be `£`, not
    // the hardcoded `$` that made a UK calculator show `$` on input while
    // the output rendered `£`.
    mocks.getPublicCashbackPreview.mockResolvedValue({
      merchantId: 'tesco-uk',
      merchantName: 'Tesco',
      orderAmountMinor: '5000',
      cashbackPct: '2.50',
      cashbackMinor: '125',
      currency: 'GBP',
    });
    renderCalculator('tesco-uk');
    // Wait for the preview to resolve (the £ output row appears).
    await waitFor(() => {
      expect(screen.getByText('£1.25')).toBeDefined();
    });
    // The glyph is the aria-hidden span sitting beside the amount input.
    const input = screen.getByLabelText(/Gift card amount/i);
    const glyph = input.parentElement?.querySelector('span[aria-hidden="true"]');
    expect(glyph?.textContent).toBe('£');
    expect(glyph?.textContent).not.toBe('$');
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
    vi.useFakeTimers();
    try {
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
      // Drive the 300ms debounce (plus margin) deterministically and
      // flush queued effects/microtasks inside act.
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      // The initial render with default $50 may have fired once; after
      // the 0 change the query stays disabled. Assert the last known
      // amountMinor was a non-zero call OR the mock was never called —
      // either is fine, we're checking we DON'T fire a fetch for 0.
      for (const call of mocks.getPublicCashbackPreview.mock.calls) {
        expect((call[0] as { amountMinor: number }).amountMinor).toBeGreaterThan(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
