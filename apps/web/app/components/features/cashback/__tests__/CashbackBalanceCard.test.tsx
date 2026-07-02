// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as UserModule from '~/services/user';
import { CashbackBalanceCard, fmtBalance } from '../CashbackBalanceCard';

afterEach(cleanup);

const { userMock, walletState } = vi.hoisted(() => ({
  userMock: {
    getMyCredits: vi.fn(),
  },
  walletState: {
    wallet: undefined as { balances: Array<{ assetCode: string; balance: string }> } | undefined,
    isActivated: false,
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
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));
// ADR 036: balance = tokens once activated; mirror is
// reconciliation-only. Default state is pre-activation so the
// original mirror-sourced tests keep exercising that path.
vi.mock('~/hooks/use-wallet', () => ({
  useWallet: () => ({
    wallet: walletState.wallet,
    isActivated: walletState.isActivated,
    balanceFor: (code: string) =>
      walletState.wallet?.balances.find((b) => b.assetCode === code)?.balance ?? '0',
    isLoading: false,
    isError: false,
  }),
}));

beforeEach(() => {
  walletState.wallet = undefined;
  walletState.isActivated = false;
  userMock.getMyCredits.mockReset();
});

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CashbackBalanceCard />
      </MemoryRouter>
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

  it('ADR 036 — activated wallet: tiles source from on-chain LOOP tokens, not the mirror', async () => {
    // balance = tokens once activated; mirror is reconciliation-only
    // (ADR 036). The mirror says £999.99 — the tokens say £42.50; the
    // tokens win, and the mirror endpoint is not even queried.
    walletState.isActivated = true;
    walletState.wallet = { balances: [{ assetCode: 'GBPLOOP', balance: '42.5000000' }] };
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '99999', updatedAt: new Date().toISOString() }],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.queryByText(/999\.99/)).toBeNull();
    // The mirror query is disabled once tokens are authoritative.
    expect(userMock.getMyCredits).not.toHaveBeenCalled();
  });

  it('ADR 036 — wallet exists but not activated: mirror display stays (tokens not emitted yet)', async () => {
    walletState.isActivated = false;
    walletState.wallet = { balances: [{ assetCode: 'GBPLOOP', balance: '42.5000000' }] };
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '12500', updatedAt: new Date().toISOString() }],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/125\.00/)).toBeDefined();
    });
    expect(screen.queryByText(/42\.50/)).toBeNull();
  });

  it('silently renders empty fragment on fetch error (ledger below is the source of truth)', async () => {
    userMock.getMyCredits.mockRejectedValue(new Error('boom'));
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <CashbackBalanceCard />
        </MemoryRouter>
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
