// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SavingsPositionView, UserAccountView } from '@loop/shared';
import { SavingsCard } from '../SavingsCard';

afterEach(cleanup);

const { accountState, userMock } = vi.hoisted(() => ({
  accountState: {
    account: undefined as UserAccountView | undefined,
    isLoading: false,
    isError: false,
  },
  userMock: {
    depositSavings: vi.fn(),
    withdrawSavings: vi.fn(),
  },
}));

vi.mock('~/hooks/use-account', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  useAccount: () => ({
    account: accountState.account,
    activeLink: null,
    isLoading: accountState.isLoading,
    isError: accountState.isError,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock('~/services/user', () => ({
  depositSavings: (body: { currency: string; amount: string }) => userMock.depositSavings(body),
  withdrawSavings: (body: { currency: string; amount: string }) => userMock.withdrawSavings(body),
}));

function position(overrides: Partial<SavingsPositionView> = {}): SavingsPositionView {
  return {
    potId: 'pot-1',
    currency: 'XLM.USDC',
    provider: 'defindex',
    principal: '5.0000000',
    value: '5.1200000',
    earnt: '0.1200000',
    locked: '1.0000000',
    available: '4.1200000',
    unlocksAt: '2026-09-24T10:00:00Z',
    estimatedApr: 0.0412,
    projectedYearlyEarnings: '0.2109440',
    ...overrides,
  };
}

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

function renderCard(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SavingsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  accountState.account = undefined;
  accountState.isLoading = false;
  accountState.isError = false;
  userMock.depositSavings.mockReset();
  userMock.withdrawSavings.mockReset();
});

describe('SavingsCard', () => {
  it('renders nothing without savings or a balance to deposit', () => {
    accountState.account = account();
    const { container } = renderCard();
    expect(container.textContent).toBe('');
  });

  it('shows the position with its lock state and yield estimate', () => {
    accountState.account = account({ savings: [position()] });
    renderCard();
    expect(screen.getByRole('heading', { name: /Savings/ })).toBeTruthy();
    expect(screen.getByText(/4\.12% APR/)).toBeTruthy();
    expect(screen.getByText(/Locked/)).toBeTruthy();
    expect(screen.getByText(/Unlocks/)).toBeTruthy();
  });

  it('offers a deposit from the account balance and posts it', async () => {
    accountState.account = account({ wallet: [{ currency: 'XLM.USDC', amount: '2.0000000' }] });
    userMock.depositSavings.mockResolvedValue({
      id: 'sop-1',
      type: 'deposit',
      potId: 'pot-1',
      status: 'complete',
      currency: 'XLM.USDC',
      amount: '1.5000000',
      created: '2026-09-23T10:00:00Z',
      finalisedAt: '2026-09-23T10:00:01Z',
      error: null,
    });
    renderCard();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1.5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Deposit into savings/ }));
    });
    await waitFor(() =>
      expect(userMock.depositSavings).toHaveBeenCalledWith({ currency: 'XLM.USDC', amount: '1.5' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('refuses a withdrawal above the available amount before calling the API', async () => {
    accountState.account = account({ savings: [position()] });
    renderCard();
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Withdraw to account/ }));
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/more than you have available/);
    expect(userMock.withdrawSavings).not.toHaveBeenCalled();
  });
});
