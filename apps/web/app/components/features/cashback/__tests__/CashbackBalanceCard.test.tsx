// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { UserAccountView } from '@loop/shared';
import { CashbackBalanceCard } from '../CashbackBalanceCard';

afterEach(cleanup);

const { accountState } = vi.hoisted(() => ({
  accountState: {
    account: undefined as UserAccountView | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('~/hooks/use-account', () => ({
  useAccount: () => ({
    account: accountState.account,
    activeLink: null,
    isLoading: accountState.isLoading,
    isError: accountState.isError,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock('~/components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

function account(overrides: Partial<UserAccountView> = {}): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  accountState.account = undefined;
  accountState.isLoading = false;
  accountState.isError = false;
});

describe('<CashbackBalanceCard />', () => {
  it('renders a spinner while the account loads', () => {
    accountState.isLoading = true;
    render(<CashbackBalanceCard />);
    expect(screen.getByTestId('spinner')).toBeTruthy();
  });

  it('renders the empty state when the wallet holds nothing', () => {
    accountState.account = account();
    render(<CashbackBalanceCard />);
    expect(screen.getByText(/No cashback yet/i)).toBeTruthy();
  });

  it('renders one tile per held currency, pegged stables as their fiat', () => {
    accountState.account = account({
      wallet: [
        { currency: 'XLM.GBPLOOP', amount: '12.5000000' },
        { currency: 'XLM.USDC', amount: '3.0000000' },
        { currency: 'XLM', amount: '1.2500000' },
      ],
    });
    render(<CashbackBalanceCard />);
    expect(screen.getByText('GBPLOOP')).toBeTruthy();
    expect(screen.getByText(/£12\.50/)).toBeTruthy();
    expect(screen.getByText(/\$3\.00/)).toBeTruthy();
    expect(screen.getByText('1.25 XLM')).toBeTruthy();
  });

  it('lists savings positions with value and earnt', () => {
    accountState.account = account({
      savings: [
        {
          currency: 'XLM.USDC',
          provider: 'ctxmock',
          principal: '5.0000000',
          value: '5.1200000',
          earnt: '0.1200000',
        },
      ],
    });
    render(<CashbackBalanceCard />);
    expect(screen.getByText('Savings')).toBeTruthy();
    expect(screen.getByText(/\$5\.12/)).toBeTruthy();
    expect(screen.getByText(/\+\$0\.12 earnt/)).toBeTruthy();
  });

  it('renders nothing on fetch error', () => {
    accountState.isError = true;
    const { container } = render(<CashbackBalanceCard />);
    expect(container.textContent).toBe('');
  });
});
