// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant, MerchantGroup } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { MerchantGroupCard } from '../MerchantGroupCard';

afterEach(cleanup);

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return { id: 'm-1', name: 'dots.eco - Plant a Tree', enabled: true, ...overrides };
}

function group(overrides: Partial<MerchantGroup> = {}): MerchantGroup {
  return {
    key: 'dots.eco',
    name: 'dots.eco',
    isGroup: true,
    members: [
      merchant({ id: 'a', name: 'dots.eco - Plant a Tree', savingsPercentage: 2 }),
      merchant({ id: 'b', name: 'dots.eco - Buy Land', savingsPercentage: 8 }),
      merchant({ id: 'c', name: 'dots.eco - Coral Reef' }),
    ],
    ...overrides,
  };
}

function renderGroup(props: Parameters<typeof MerchantGroupCard>[0]): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MerchantGroupCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MerchantGroupCard (ADR 032)', () => {
  it('renders the brand name, not a variant name', () => {
    renderGroup({ group: group() });
    expect(screen.getByText('dots.eco')).toBeDefined();
    expect(screen.queryByText(/Plant a Tree/)).toBeNull();
  });

  it('shows the option count', () => {
    renderGroup({ group: group() });
    expect(screen.getByText('3 options')).toBeDefined();
    expect(screen.getByText(/3 gift cards to choose from/)).toBeDefined();
  });

  it('links to the brand view (/brand/:slug)', () => {
    renderGroup({ group: group() });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(`/brand/${merchantSlug('dots.eco')}`);
  });

  it('advertises the best savings across variants', () => {
    renderGroup({ group: group() });
    // max of 2% and 8% → "Save up to 8.0%"
    expect(screen.getByText(/Save up to 8\.0%/)).toBeDefined();
  });

  it('shows the best cashback rate across variants', () => {
    const lookup = (id: string): string | null =>
      id === 'b' ? '4.00' : id === 'a' ? '2.00' : null;
    renderGroup({ group: group(), lookupCashback: lookup });
    expect(screen.getByText(/4% cashback/)).toBeDefined();
  });

  it('omits savings/cashback badges when no variant carries them', () => {
    const g = group({
      members: [
        merchant({ id: 'x', name: 'dots.eco - A' }),
        merchant({ id: 'y', name: 'dots.eco - B' }),
      ],
    });
    renderGroup({ group: g });
    expect(screen.queryByText(/Save up to/)).toBeNull();
    expect(screen.queryByText(/cashback/)).toBeNull();
  });
});
