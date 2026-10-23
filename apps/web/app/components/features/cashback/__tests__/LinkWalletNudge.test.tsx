// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { UserAccountView, WalletLinkView } from '@loop/shared';

const { accountState } = vi.hoisted(() => ({
  accountState: {
    account: undefined as UserAccountView | undefined,
    activeLink: null as WalletLinkView | null,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('~/hooks/use-account', () => ({
  ACCOUNT_QUERY_KEY: ['me', 'account'],
  useAccount: () => ({
    account: accountState.account,
    activeLink: accountState.activeLink,
    isLoading: accountState.isLoading,
    isError: accountState.isError,
    error: null,
    refetch: () => undefined,
  }),
}));

import { LinkWalletNudge } from '../LinkWalletNudge';

function account(wallet: UserAccountView['wallet']): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet,
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T00:00:00Z',
  };
}

const link: WalletLinkView = {
  id: 'w-1',
  chain: 'XLM',
  address: 'G' + 'A'.repeat(55),
  autoPayout: true,
  status: 'active',
  created: '2026-09-23T00:00:00Z',
  removed: null,
};

function renderNudge(): HTMLElement {
  return render(
    <MemoryRouter>
      <LinkWalletNudge />
    </MemoryRouter>,
  ).container;
}

afterEach(cleanup);

beforeEach(() => {
  accountState.account = undefined;
  accountState.activeLink = null;
  accountState.isLoading = false;
  accountState.isError = false;
});

describe('<LinkWalletNudge />', () => {
  it('renders the CTA when the wallet holds cashback and no wallet is linked', () => {
    accountState.account = account([{ currency: 'XLM.GBPLOOP', amount: '0.4000000' }]);
    renderNudge();
    expect(screen.getByRole('link', { name: /wallet settings/i })).toBeTruthy();
  });

  it('hides once a wallet is linked', () => {
    accountState.account = account([{ currency: 'XLM.GBPLOOP', amount: '0.4000000' }]);
    accountState.activeLink = link;
    expect(renderNudge().innerHTML).toBe('');
  });

  it('hides while the balance is zero', () => {
    accountState.account = account([{ currency: 'XLM.GBPLOOP', amount: '0' }]);
    expect(renderNudge().innerHTML).toBe('');
  });

  it('hides while loading and on error', () => {
    accountState.isLoading = true;
    expect(renderNudge().innerHTML).toBe('');
    cleanup();
    accountState.isLoading = false;
    accountState.isError = true;
    expect(renderNudge().innerHTML).toBe('');
  });
});
