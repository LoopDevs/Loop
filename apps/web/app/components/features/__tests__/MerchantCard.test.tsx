// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { MerchantCard } from '../MerchantCard';

afterEach(cleanup);

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: 'm-1',
    name: 'Target',
    enabled: true,
    ...overrides,
  };
}

// MerchantCard now embeds `FavoriteToggleButton`, which calls
// `useAuth` (and therefore `useQueryClient`). Wrap renders in a
// `QueryClientProvider` so the hook resolves; the auth store
// defaults to signed-out so the heart button self-hides and these
// cashback-badge assertions remain undisturbed.
function renderCard(props: Parameters<typeof MerchantCard>[0]): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MerchantCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MerchantCard — cashback badge (ADR 011 / 015)', () => {
  it('does not render the badge when userCashbackPct is null', () => {
    renderCard({ merchant: merchant(), userCashbackPct: null });
    expect(screen.queryByText(/cashback/i)).toBeNull();
  });

  it('does not render the badge when userCashbackPct is undefined (prop omitted)', () => {
    renderCard({ merchant: merchant() });
    expect(screen.queryByText(/cashback/i)).toBeNull();
  });

  it('does not render the badge when the rate parses to 0', () => {
    renderCard({ merchant: merchant(), userCashbackPct: '0.00' });
    expect(screen.queryByText(/cashback/i)).toBeNull();
  });

  it('renders the badge for a valid positive rate', () => {
    renderCard({ merchant: merchant(), userCashbackPct: '2.50' });
    // Fraction kept for non-integer rates
    expect(screen.getByText(/2\.5% cashback/)).toBeDefined();
  });

  it('drops the trailing .0 on whole-integer rates', () => {
    renderCard({ merchant: merchant(), userCashbackPct: '5.00' });
    // "5% cashback" reads cleaner than "5.0% cashback" on the compact pill
    expect(screen.getByText(/5% cashback/)).toBeDefined();
  });

  it('renders both badges (savings + cashback) when both are present', () => {
    renderCard({
      merchant: merchant({ savingsPercentage: 3 }),
      userCashbackPct: '2',
    });
    expect(screen.getByText(/Save 3\.0%/)).toBeDefined();
    expect(screen.getByText(/2% cashback/)).toBeDefined();
  });
});
