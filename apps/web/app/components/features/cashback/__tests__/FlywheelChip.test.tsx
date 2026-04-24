// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { formatMinorCurrency as formatMinor, pctBigint } from '@loop/shared';
import { FlywheelChip } from '../FlywheelChip';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserFlywheelStats: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserFlywheelStats: () => userMock.getUserFlywheelStats(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));

function renderChip(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FlywheelChip />
    </QueryClientProvider>,
  );
}

describe('formatMinor', () => {
  it('formats bigint minor as localized currency', () => {
    expect(formatMinor(4200n, 'GBP')).toMatch(/£42\.00/);
    expect(formatMinor(50n, 'USD')).toMatch(/\$0\.50/);
  });

  it('preserves bigint precision past 2^53', () => {
    const out = formatMinor(9_007_199_254_740_993n, 'USD');
    expect(out).toContain('90,071,992,547,409');
  });

  // A2-1520: admin JSON comes back as bigint-as-string; the helper
  // must accept that shape and stay bigint-safe across the coerce.
  it('accepts string input and preserves precision past 2^53', () => {
    const out = formatMinor('9007199254740993', 'USD');
    expect(out).toContain('90,071,992,547,409');
  });

  it('accepts number input for small amounts', () => {
    expect(formatMinor(4200, 'GBP')).toMatch(/£42\.00/);
  });

  it('returns em-dash for unparseable input', () => {
    expect(formatMinor('not-a-number', 'USD')).toBe('—');
    expect(formatMinor(Number.NaN, 'USD')).toBe('—');
  });
});

describe('pctBigint', () => {
  it('formats percentage with one decimal', () => {
    expect(pctBigint(50n, 200n)).toBe('25.0%');
    expect(pctBigint(1n, 3n)).toBe('33.3%');
  });

  it('returns null for zero denominator', () => {
    expect(pctBigint(5n, 0n)).toBeNull();
  });
});

describe('<FlywheelChip />', () => {
  it('silently hides for users with no recycled orders', async () => {
    userMock.getUserFlywheelStats.mockResolvedValue({
      currency: 'GBP',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 5,
      totalFulfilledChargeMinor: '20000',
    });
    const { container } = renderChip();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Cashback recycled"]')).toBeNull();
    });
  });

  it('silently hides on fetch error (motivational accent, not load-bearing)', async () => {
    userMock.getUserFlywheelStats.mockRejectedValue(new Error('boom'));
    const { container } = renderChip();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Cashback recycled"]')).toBeNull();
    });
  });

  it('renders recycled chip with charge + count + percentage on the happy path', async () => {
    userMock.getUserFlywheelStats.mockResolvedValue({
      currency: 'GBP',
      recycledOrderCount: 3,
      recycledChargeMinor: '4500',
      totalFulfilledCount: 10,
      totalFulfilledChargeMinor: '20000',
    });
    renderChip();
    await waitFor(() => {
      expect(screen.getByLabelText(/Cashback recycled/i)).toBeDefined();
    });
    expect(screen.getByText(/recycled/i)).toBeDefined();
    expect(screen.getByText(/45\.00/)).toBeDefined();
    expect(screen.getByText(/3 orders/i)).toBeDefined();
    // 4500 / 20000 = 22.5%.
    expect(screen.getByText(/22\.5% of your total spend/i)).toBeDefined();
  });

  it('uses singular "order" for recycledOrderCount === 1', async () => {
    userMock.getUserFlywheelStats.mockResolvedValue({
      currency: 'GBP',
      recycledOrderCount: 1,
      recycledChargeMinor: '500',
      totalFulfilledCount: 2,
      totalFulfilledChargeMinor: '1000',
    });
    renderChip();
    await waitFor(() => {
      expect(screen.getByText(/1 order\b/i)).toBeDefined();
    });
    // Not "1 orders".
    expect(screen.queryByText(/1 orders/i)).toBeNull();
  });
});
