// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PayoutView, UserAccountView } from '@loop/shared';
import { PayoutsCard } from '../PayoutsCard';

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

function payout(overrides: Partial<PayoutView> = {}): PayoutView {
  return {
    id: 'p-1',
    status: 'complete',
    chain: 'XLM',
    address: 'G' + 'A'.repeat(55),
    currency: 'XLM.GBPLOOP',
    amount: '1.2500000',
    giftCardId: 'gc-1',
    txHash: null,
    transferId: null,
    error: null,
    created: '2026-09-23T10:00:00Z',
    finalised: '2026-09-23T10:00:05Z',
    ...overrides,
  };
}

function account(payouts: PayoutView[]): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [],
    payouts,
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
  };
}

beforeEach(() => {
  accountState.account = undefined;
  accountState.isLoading = false;
  accountState.isError = false;
});

describe('<PayoutsCard />', () => {
  it('renders nothing when there are no payouts or on error', () => {
    accountState.account = account([]);
    expect(render(<PayoutsCard />).container.textContent).toBe('');
    cleanup();
    accountState.isError = true;
    expect(render(<PayoutsCard />).container.textContent).toBe('');
  });

  it('renders each payout with a status pill and pegged fiat amount', () => {
    accountState.account = account([
      payout(),
      payout({ id: 'p-2', status: 'pending', finalised: null, currency: 'XLM.USDC', amount: '2' }),
      payout({ id: 'p-3', status: 'failed', error: 'op_no_trust' }),
    ]);
    render(<PayoutsCard />);
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('Sending')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getAllByText(/£1\.25/).length).toBe(2);
    expect(screen.getByText(/\$2\.00/)).toBeTruthy();
    expect(screen.getByText(/Support is reviewing/)).toBeTruthy();
  });

  it('links to stellar.expert only when a tx hash exists', () => {
    accountState.account = account([payout({ txHash: 'abc' }), payout({ id: 'p-2' })]);
    render(<PayoutsCard />);
    const links = screen.getAllByRole('link', { name: /View tx/i }) as HTMLAnchorElement[];
    expect(links.length).toBe(1);
    expect(links[0]!.href).toContain('/tx/abc');
  });
});
