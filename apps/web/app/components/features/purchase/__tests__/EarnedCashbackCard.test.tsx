// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { rateMock } = vi.hoisted(() => ({
  rateMock: {
    userCashbackPct: null as string | null,
  },
}));

vi.mock('~/hooks/use-merchants', () => ({
  useMerchantCashbackRate: () => ({ userCashbackPct: rateMock.userCashbackPct }),
}));

import { EarnedCashbackCard } from '../EarnedCashbackCard';

function renderCard(
  props: { merchantId?: string; amount?: number; currency?: string } = {},
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EarnedCashbackCard
          merchantId={props.merchantId ?? 'm-1'}
          amount={props.amount ?? 50}
          currency={props.currency ?? 'USD'}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rateMock.userCashbackPct = null;
});

afterEach(cleanup);

describe('EarnedCashbackCard', () => {
  it('renders nothing when the merchant has no active cashback config', () => {
    rateMock.userCashbackPct = null;
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the rate parses to 0', () => {
    rateMock.userCashbackPct = '0';
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the amount is 0 or invalid', () => {
    rateMock.userCashbackPct = '2.50';
    const { container } = renderCard({ amount: 0 });
    expect(container.firstChild).toBeNull();
  });

  it('renders the earned amount for a valid rate + amount combo', () => {
    rateMock.userCashbackPct = '2.50';
    renderCard({ amount: 50, currency: 'USD' });
    // 50 * 2.50% = $1.25
    expect(screen.getByText(/You earned \$1\.25 cashback/)).toBeDefined();
  });

  it('drops trailing .00 on whole-unit estimates', () => {
    rateMock.userCashbackPct = '10.00';
    renderCard({ amount: 50 });
    expect(screen.getByText(/You earned \$5 cashback/)).toBeDefined();
  });

  it('honours the merchant currency symbol (£ for GBP)', () => {
    rateMock.userCashbackPct = '5';
    renderCard({ amount: 20, currency: 'GBP' });
    expect(screen.getByText(/You earned £1 cashback/)).toBeDefined();
  });

  it('links to /settings/cashback so the user can drill into history', () => {
    rateMock.userCashbackPct = '2';
    renderCard({ amount: 25 });
    const link = screen.getByRole('link', { name: /View →/ });
    expect(link.getAttribute('href')).toBe('/settings/cashback');
  });
});
