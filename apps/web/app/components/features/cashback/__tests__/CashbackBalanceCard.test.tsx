// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { CashbackBalanceCard, fmtBalance } from '../CashbackBalanceCard';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getMyCredits: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMyCredits: () => userMock.getMyCredits(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CashbackBalanceCard />
    </QueryClientProvider>,
  );
}

describe('fmtBalance', () => {
  it('formats GBP minor as localized currency', () => {
    expect(fmtBalance('12345', 'GBP')).toMatch(/123\.45/);
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtBalance('abc', 'GBP')).toBe('—');
  });
});

describe('<CashbackBalanceCard />', () => {
  it('renders empty-state when credits array is empty', async () => {
    userMock.getMyCredits.mockResolvedValue({ credits: [] });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No cashback yet/)).toBeDefined();
    });
  });

  it('renders one tile per currency with formatted balance', async () => {
    userMock.getMyCredits.mockResolvedValue({
      credits: [
        { currency: 'GBP', balanceMinor: '12500', updatedAt: new Date().toISOString() },
        { currency: 'USD', balanceMinor: '500', updatedAt: new Date().toISOString() },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/125\.00/)).toBeDefined();
    });
    // Both balances end in ".00"; the 125 one is checked above.
    // $5.00 is the second tile — assert by the dollar sign + digit.
    expect(screen.getByText(/\$5\.00/)).toBeDefined();
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.getByText('USD')).toBeDefined();
  });

  it('silently renders empty fragment on fetch error (ledger below is the source of truth)', async () => {
    userMock.getMyCredits.mockRejectedValue(new Error('boom'));
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CashbackBalanceCard />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(userMock.getMyCredits).toHaveBeenCalled();
    });
    // Either nothing rendered, or a comment/fragment placeholder; no
    // visible error banner.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/fail/i);
  });
});
